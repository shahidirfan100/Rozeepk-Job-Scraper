// Rozee.pk static HTML scraper (CheerioCrawler + gotScraping)
// Focus: extract visible job links and basic details from static HTML (no JSON-LD).

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls = ['https://www.rozee.pk/'],
        maxJobs = 100,
        proxyConfiguration,
        minDelayMs = 800,
        maxDelayMs = 1500,
    } = input;

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

    const jitter = () => {
        const min = Number(minDelayMs);
        const max = Number(maxDelayMs);
        return min + Math.floor(Math.random() * (max - min + 1));
    };

    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try {
            return new URL(href, base).href.split('#')[0];
        } catch {
            return null;
        }
    };

    let saved = 0;

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 2,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 120,
        preNavigationHooks: [
            async ({ request, session }, gotOptions) => {
                const ua =
                    session?.userData?.ua ||
                    (session.userData.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
                        100 + Math.floor(Math.random() * 15)
                    }.0.0.0 Safari/537.36`);
                request.headers = {
                    'user-agent': ua,
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                };
                gotOptions.http2 = true;
                gotOptions.useHeaderGenerator = true;
                await sleep(jitter());
            },
        ],
        requestHandler: async ({ request, $, enqueueLinks, log: crawlerLog }) => {
            const label = request.userData.label || 'LIST';

            // ----- LIST PAGE -----
            if (label === 'LIST') {
                crawlerLog.info(`Processing listing page: ${request.url}`);

                // Find job links visible in static HTML
                const jobLinks = new Set();
                $('a[href^="https://www.rozee.pk/"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (
                        href &&
                        !/\/(company|career|login|about|contact|signup|privacy)/i.test(href) &&
                        /^https:\/\/www\.rozee\.pk\/[a-zA-Z0-9]{6,12}$/.test(href)
                    ) {
                        jobLinks.add(toAbs(href));
                    }
                });

                const uniqueJobs = [...jobLinks];
                crawlerLog.info(`Found ${uniqueJobs.length} job links`);

                const limited = uniqueJobs.slice(0, maxJobs - saved);
                await enqueueLinks({
                    urls: limited,
                    transformRequestFunction: (req) => {
                        req.userData = { label: 'DETAIL' };
                        return req;
                    },
                });

                // Note: JS-driven pagination cannot be followed with Cheerio
                // We scrape only static HTML jobs available on this page.
                return;
            }

            // ----- DETAIL PAGE -----
            if (label === 'DETAIL') {
                crawlerLog.info(`Processing job detail: ${request.url}`);
                let title = $('h1, h2, h3').first().text().trim();
                if (!title) title = $('title').text().split('|')[0].trim();

                let company =
                    $('a[href*="/company/"]').first().text().trim() ||
                    $('[class*="company"]').first().text().trim() ||
                    $('h4:contains("Company")').next().text().trim();

                const location =
                    $('[class*="location"]').first().text().trim() ||
                    $('li:contains("Location")').next().text().trim() ||
                    $('div:contains("Location")').next().text().trim() ||
                    'Pakistan';

                const salary =
                    $('li:contains("Salary")').next().text().trim() ||
                    $('div:contains("Salary")').next().text().trim() ||
                    'Not specified';

                const description =
                    $('div[class*="description"], section[class*="description"]').text().trim() ||
                    $('body').text().slice(0, 1000);

                if (!title || !company) {
                    crawlerLog.warning(`Skipping job (missing title or company): ${request.url}`);
                    return;
                }

                const job = {
                    url: request.url,
                    title,
                    company,
                    location,
                    salary,
                    description: description.slice(0, 2000),
                    scrapedAt: new Date().toISOString(),
                };

                await Dataset.pushData(job);
                saved++;
                crawlerLog.info(`Saved job ${saved}: ${title} @ ${company}`);
                await sleep(jitter());
            }
        },
    });

    // start crawler
    const startRequests = startUrls.map((u) => ({ url: u, userData: { label: 'LIST' } }));
    await crawler.run(startRequests);

    log.info('Scraping completed', { totalJobsSaved: saved });
}

try {
    await main();
} catch (err) {
    log.error('Fatal error:', err);
    throw err;
} finally {
    await Actor.exit();
}
