// Rozee.pk jobs scraper – HTTP-only (CheerioCrawler + gotScraping), no Playwright.
// Updated with working job link selector: #jobs h3 a (converted from XPath).
// Strategy: rely on static HTML anchors, clean DOM parsing, and anti-blocking measures.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        datePosted = 'all',
        results_wanted: MAX_ITEMS_RAW = 80,
        max_pages: MAX_PAGES_RAW = 25,
        collectDetails = true,
        startUrl: startUrls = [],
        url,
        proxyConfiguration,
        minDelayMs = 700,
        maxDelayMs = 1600,
    } = input;

    const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

    log.info('Config', { MAX_ITEMS, MAX_PAGES, collectDetails, keyword, datePosted });

    // ---------- helpers ----------
    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try { return new URL(href, base).href.split('#')[0]; } catch { return null; }
    };

    const cleanText = (html) => {
        if (!html) return '';
        const $ = cheerioLoad(html);
        $('script, style, noscript, iframe').remove();
        return $.root().text().replace(/\s+/g, ' ').trim();
    };

    const looksLikeCfBlock = ($) => {
        const t = ($('title').text() || '').toLowerCase();
        const b = ($('body').text() || '').toLowerCase();
        return t.includes('attention required') ||
               b.includes('cloudflare') && (b.includes('checking your browser') || b.includes('verify you are a human'));
    };

    const isWithinDateFilter = (dateStr, filter) => {
        if (!dateStr || filter === 'all') return true;
        const now = new Date();
        const cutoffHours = filter === '24hours' ? 24 : filter === '7days' ? 168 : filter === '30days' ? 720 : 0;
        if (!cutoffHours) return true;
        const s = (dateStr || '').toLowerCase();

        const mH = s.match(/(\d+)\s*hours?/i);
        if (mH) return parseInt(mH[1], 10) <= cutoffHours;

        const mD = s.match(/(\d+)\s*days?/i);
        if (mD) return (parseInt(mD[1], 10) * 24) <= cutoffHours;

        if (s.includes('today')) return true;
        if (s.includes('yesterday')) return cutoffHours >= 24;

        const mDate = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),\s+(\d{4})/i);
        if (mDate) {
            const jobDate = new Date(mDate[0]);
            const diffMs = now - jobDate;
            return (diffMs / (1000 * 60 * 60)) <= cutoffHours;
        }
        return true;
    };

    const jitter = () => {
        const min = Math.max(0, Number(minDelayMs) || 0);
        const max = Math.max(min, Number(maxDelayMs) || min);
        return min + Math.floor(Math.random() * (max - min + 1));
    };

    const buildKeywordUrl = () => {
        if (keyword && keyword.trim()) {
            const slug = keyword.trim().toLowerCase().replace(/\s+/g, '-');
            return `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(slug)}`;
        }
        return 'https://www.rozee.pk/job/jsearch/q/all';
    };

    // ---------- seeds ----------
    const seeds = new Set();
    seeds.add('https://www.rozee.pk/job/jsearch/q/all');
    const inputUrls = Array.isArray(startUrls) ? startUrls : (startUrls ? [startUrls] : []);
    inputUrls.forEach(u => { if (typeof u === 'string' && u.includes('rozee.pk')) seeds.add(u); });
    if (url && typeof url === 'string' && url.includes('rozee.pk')) seeds.add(url);
    seeds.add(buildKeywordUrl());

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

    let saved = 0;
    const failedUrls = [];

    // ---------- crawler ----------
    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 2,
        maxRequestRetries: 7,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 15, sessionOptions: { maxUsageCount: 20 } },
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 90,

        preNavigationHooks: [
            async ({ request, session }, gotOptions) => {
                const ua = session?.userData?.ua ||
                    (session.userData.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${110 + Math.floor(Math.random() * 20)}.0.0.0 Safari/537.36`);
                request.headers = {
                    'user-agent': ua,
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'upgrade-insecure-requests': '1',
                };
                gotOptions.throwHttpErrors = false;
                gotOptions.http2 = true;
                gotOptions.decompress = true;
                gotOptions.cookieJar = session?.cookieJar;
                gotOptions.useHeaderGenerator = true;
                gotOptions.headerGeneratorOptions = {
                    browsers: [{ name: 'chrome', minVersion: 110, httpVersion: '2' }],
                    devices: ['desktop'],
                    operatingSystems: ['windows'],
                    locales: ['en-US'],
                };
                await sleep(jitter());
            },
        ],

        requestHandler: async ({ request, $, enqueueLinks, response, session, log: clog }) => {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;
            const status = response?.statusCode || 200;

            if ([403, 429, 503].includes(status) || !$) {
                session?.retire?.();
                throw new Error(`Blocked or empty DOM on ${request.url} (HTTP ${status})`);
            }

            // ============================
            // LIST PAGE HANDLER
            // ============================
            if (['LIST', 'GEN'].includes(label)) {
                clog.info(`Processing LIST page ${pageNo}: ${request.url}`);
                if (looksLikeCfBlock($)) {
                    session?.retire?.();
                    throw new Error('Detected Cloudflare');
                }

                // ✅ Updated selector: converted from XPath //*[@id="jobs"]/div[3]/div[1]/div[1]/div/h3
                const jobLinks = new Set();
                $('#jobs h3 a').each((_, el) => {
                    const href = $(el).attr('href');
                    if (
                        href &&
                        href.startsWith('https://www.rozee.pk/') &&
                        !/\/(company|career|login|signup|about|contact)/i.test(href)
                    ) {
                        jobLinks.add(toAbs(href));
                    }
                });

                clog.info(`Found ${jobLinks.size} job links`, { sample: Array.from(jobLinks).slice(0, 5) });

                if (collectDetails && jobLinks.size > 0) {
                    const remaining = MAX_ITEMS - saved;
                    const toEnqueue = Array.from(jobLinks).slice(0, remaining);
                    if (toEnqueue.length) {
                        await enqueueLinks({
                            urls: toEnqueue,
                            transformRequestFunction: (req) => {
                                req.userData = { label: 'DETAIL' };
                                return req;
                            },
                        });
                    }
                }

                await sleep(jitter());
                return;
            }

            // ============================
            // DETAIL PAGE HANDLER
            // ============================
            if (label === 'DETAIL') {
                clog.info(`Processing DETAIL page: ${request.url}`);
                if (looksLikeCfBlock($)) {
                    session?.retire?.();
                    throw new Error('Detected Cloudflare on detail');
                }

                try {
                    let title = $('h1, h2, h3').first().text().trim();
                    if (!title) title = $('title').text().split('|')[0].trim();

                    let company =
                        $('a[href*="/company/"]').first().text().trim() ||
                        $('[class*="company"]').first().text().trim() ||
                        $('h4:contains("Company")').next().text().trim();

                    const location =
                        $('[class*="location"]').first().text().trim() ||
                        $('li:contains("Location")').next().text().trim() ||
                        'Pakistan';

                    const salary =
                        $('li:contains("Salary")').next().text().trim() ||
                        $('div:contains("Salary")').next().text().trim() ||
                        'Not specified';

                    const description =
                        $('div[class*="description"], section[class*="description"]').text().trim() ||
                        $('body').text().slice(0, 1000);

                    if (!title || !company) {
                        clog.warning(`Skipping job (missing title/company): ${request.url}`);
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
                    clog.info(`✅ Saved job ${saved}: ${title} @ ${company}`);
                    await sleep(jitter());
                } catch (err) {
                    clog.error(`DETAIL error ${request.url}: ${err.message}`);
                    failedUrls.push({ url: request.url, reason: err.message });
                }
            }
        },

        failedRequestHandler: async ({ request, error, session, log: clog }) => {
            clog.error(`Request failed: ${request.url}`, { error: error?.message });
            session?.retire?.();
            failedUrls.push({ url: request.url, reason: error?.message });
        },
    });

    const startRequests = [];
    for (const s of seeds) {
        startRequests.push({ url: s, userData: { label: 'LIST', pageNo: 1 } });
    }

    await crawler.run(startRequests);
    log.info('Done', { totalJobsSaved: saved, failedUrls: failedUrls.length });
}

try {
    await main();
} catch (err) {
    log.error('Fatal error:', err);
    throw err;
} finally {
    await Actor.exit();
}
