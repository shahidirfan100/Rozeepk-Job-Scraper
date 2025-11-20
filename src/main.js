// Hybrid RozeePk scraper: Cheerio for LIST pages, Playwright for DETAIL pages
import { Actor, log } from 'apify';
import { PlaywrightCrawler, CheerioCrawler, Dataset } from 'crawlee';

// ---------- Shared helpers ----------

const toAbs = (href, base = 'https://www.rozee.pk') => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const cleanText = (text) => {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
};

const validateJobItem = (item) => {
    // Basic validation: must have title and url
    if (!item.title || !item.url) {
        return false;
    }
    // Clean all text fields
    Object.keys(item).forEach(key => {
        if (typeof item[key] === 'string') {
            item[key] = cleanText(item[key]);
        }
    });
    return true;
};

const buildStartUrl = (kw, loc, cat) => {
    let path = 'q/all';
    if (kw && kw.trim()) {
        path = `q/${encodeURIComponent(kw.trim())}`;
    }
    return `https://www.rozee.pk/job/jsearch/${path}/fc/1`;
};

// ---------- MAIN ----------

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};

    const {
        keyword = '',
        location = '',
        category = '',
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 999,
        collectDetails = true,
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
        ? Math.max(1, +MAX_PAGES_RAW)
        : 999;

    const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);

    // Initial LIST URLs
    const initialUrls = [];
    if (Array.isArray(startUrls) && startUrls.length) initialUrls.push(...startUrls);
    if (startUrl) initialUrls.push(startUrl);
    if (url) initialUrls.push(url);
    if (!initialUrls.length) initialUrls.push(buildStartUrl(keyword, location, category));

    let saved = 0;
    const detailUrls = new Set(); // for DETAIL phase

    // ---------- LIST helpers (Cheerio) ----------

    function findJobLinksCheerio($, crawlerLog) {
        const links = new Set();
        const jobLinkRegex = /\/.*-jobs-\d+(?:\?.*)?$/i;

        $('a[href*="-jobs-"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            if (!jobLinkRegex.test(href)) return;
            const absoluteUrl = toAbs(href);
            if (absoluteUrl && absoluteUrl.includes('rozee.pk')) {
                links.add(absoluteUrl);
            }
        });

        crawlerLog.info(`Cheerio: found ${links.size} job links on this page`);
        return [...links];
    }

    function extractJobsFromList($) {
        const jobs = [];
        // Each job is in a section with h3 title
        $('h3 a[href*="-jobs-"]').each((_, el) => {
            try {
                const $el = $(el);
                const title = cleanText($el.text());
                const url = toAbs($el.attr('href'));
                if (!title || !url) return;

                // Get the entire job container (usually the next sibling or parent)
                const $jobContainer = $el.closest('div').next('div') || $el.parent().parent();

                const containerText = $jobContainer.text();

                // Company and Location: [Company, ][Location, Pakistan]
                const companyLocMatch = containerText.match(/\[([^\]]+),\s*\]\s*\[([^\]]+),\s*Pakistan\]/);
                const company = companyLocMatch ? companyLocMatch[1].trim() : null;
                const location = companyLocMatch ? companyLocMatch[2].trim() + ', Pakistan' : null;

                // Date: Nov 15, 2025
                const dateMatch = containerText.match(/([A-Za-z]{3} \d{1,2}, \d{4})/);
                const date_posted = dateMatch ? dateMatch[1] : null;

                // Experience: Less than 1 Year
                const expMatch = containerText.match(/([^]+?)(?=|$)/);
                const experience = expMatch ? expMatch[1].trim() : null;

                // Salary: 35K - 150K
                const salaryMatch = containerText.match(/([^\s]+)/);
                const salary = salaryMatch ? 'PKR ' + salaryMatch[1] : null;

                // Description: text before the icons
                const descParts = containerText.split(/||/);
                const description_text = descParts[0] ? cleanText(descParts[0]).substring(0, 300) : null;

                const job = {
                    title,
                    company,
                    location,
                    salary,
                    contract_type: 'Full Time', // default assumption
                    date_posted,
                    description_text,
                    url,
                };

                if (validateJobItem(job)) {
                    jobs.push(job);
                }
            } catch (error) {
                log.warning(`Error extracting job from list: ${error.message}`);
            }
        });
        return jobs;
    }

    // ---------- CheerioCrawler (LIST pages) ----------

    const cheerioCrawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 2,
        maxConcurrency: 20, // Cheerio is cheap
        requestHandlerTimeoutSecs: 30,
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;
            if (label !== 'LIST') return;

            const links = findJobLinksCheerio($, crawlerLog);
            crawlerLog.info(
                `LIST page ${pageNo}: ${links.length} job links (saved=${saved}, target=${RESULTS_WANTED}, collectedDetails=${detailUrls.size})`,
            );

            if (links.length === 0) {
                crawlerLog.warning(`No job links found on page ${pageNo}`);
                if (pageNo > 1) {
                    crawlerLog.warning(`Stopping pagination at page ${pageNo}`);
                    return;
                }
            }

            if (collectDetails) {
                for (const link of links) {
                    if (detailUrls.size >= RESULTS_WANTED) break;
                    detailUrls.add(link);
                }
            } else {
                // Extract job data from list page
                const jobs = extractJobsFromList($);
                const remaining = RESULTS_WANTED - saved;
                const toPush = jobs.slice(0, Math.max(0, remaining));
                if (toPush.length) {
                    await Dataset.pushData(toPush);
                    saved += toPush.length;
                }
            }

            if (collectDetails && detailUrls.size >= RESULTS_WANTED) {
                crawlerLog.info(
                    `Collected enough detail URLs (${detailUrls.size}), not enqueueing more pages.`,
                );
                return;
            }

            if (pageNo < MAX_PAGES && links.length > 0) {
                const nextUrl = buildNextPageUrl(request.url);
                await enqueueLinks({
                    urls: [nextUrl],
                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                });
            }
        },
    });

    // ---------- PlaywrightCrawler (DETAIL pages) ----------

    const playwrightCrawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 30,
            sessionOptions: {
                maxUsageCount: 50,
                maxAgeSecs: 24 * 60 * 60,
            },
        },
        persistCookiesPerSession: true,
        // Give autoscaler headroom; it will back off if CPU is too high
        maxConcurrency: 25,
        minConcurrency: 5,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 30,
        navigationTimeoutSecs: 15,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--mute-audio',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-first-run',
                    '--lang=en-PK',
                ],
            },
        },
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                locales: ['en-PK'],
                browsers: ['chromium'],
                timeZones: ['Asia/Karachi'],
            },
            retireBrowserAfterPageCount: 60,
            maxOpenPagesPerBrowser: 2,
        },
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                // Block heavy resources for speed
                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                        route.abort();
                    } else {
                        route.continue();
                    }
                });

                // We only need the DOM, not full load
                gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],
        failedRequestHandler: async ({ request, error }) => {
            log.error(`DETAIL failed ${request.url}: ${error.message}`);
        },
        async requestHandler({ request, page, log: crawlerLog }) {
            if (saved >= RESULTS_WANTED) return;

            let retryCount = 0;
            const maxRetries = 3;

            while (retryCount < maxRetries) {
                try {
                    // Cookie banner (if any)
                    try {
                        await page.click('#cookie-accept, .cookie-accept', { timeout: 2000 });
                        await page.waitForTimeout(200);
                    } catch {
                        // ignore
                    }

                    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {
                        throw new Error('Job title not found');
                    });

                    // Check if it's a valid job page
                    const pageTitle = await page.title();
                    if (pageTitle.includes('404') || pageTitle.includes('Not Found') || !pageTitle.includes('Jobs')) {
                        throw new Error('Invalid job page');
                    }

                    const data = await page.evaluate(() => {
                        const result = {};

                        // Check for JSON-LD first
                        try {
                            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                            for (const script of scripts) {
                                const json = JSON.parse(script.textContent);
                                const data = Array.isArray(json) ? json : [json];
                                for (const item of data) {
                                    if (item['@type'] === 'JobPosting') {
                                        result.title = item.title;
                                        result.company = item.hiringOrganization?.name;
                                        if (item.jobLocation?.address) {
                                            const addr = item.jobLocation.address;
                                            result.location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
                                        }
                                        if (item.baseSalary?.value) {
                                            result.salary = 'PKR ' + item.baseSalary.value;
                                        }
                                        result.contract_type = item.employmentType?.[0] || item.employmentType;
                                        result.date_posted = item.datePosted;
                                        result.description_text = item.description?.replace(/<[^>]*>/g, '') || item.description;
                                        result.description_html = item.description;
                                        return result;
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore JSON-LD errors, fallback to DOM
                        }

                        // Fallback to DOM parsing
                        // Title
                        const h1 = document.querySelector('h1');
                        result.title = h1 ? h1.innerText.trim() : null;

                        // Company
                        const companyEl = document.querySelector('h2 a');
                        result.company = companyEl ? companyEl.innerText.trim() : null;

                        // Location from Job Details section
                        const jobDetailsText = document.body.innerText;
                        const locationMatch = jobDetailsText.match(/Job Location:\s*([^<\n]+)/);
                        if (locationMatch) {
                            result.location = locationMatch[1].trim();
                        }

                        // Salary
                        const salaryMatch = jobDetailsText.match(/PKR\.?\s*[\d,]+(?:\s*-\s*[\d,]+)?\/?\s*(?:Month|Year)/i);
                        result.salary = salaryMatch ? salaryMatch[0] : null;

                        // Date posted
                        const dateMatch = jobDetailsText.match(/Posting Date:\s*([A-Za-z]{3} \d{1,2}, \d{4})/);
                        result.date_posted = dateMatch ? dateMatch[1] : null;

                        // Contract type / Job type
                        const jobTypeMatch = jobDetailsText.match(/Job Type:\s*([^<\n]+)/);
                        result.contract_type = jobTypeMatch ? jobTypeMatch[1].trim() : null;

                        // Description: text after "Job Description"
                        const bodyText = document.body.innerText;
                        const descStart = bodyText.indexOf('Job Description');
                        if (descStart !== -1) {
                            const descText = bodyText.substring(descStart + 'Job Description'.length).split('Skills')[0].trim();
                            result.description_text = descText;
                            result.description_html = descText.replace(/\n/g, '<br>');
                        }

                        return result;
                    });

                    const item = {
                        title: cleanText(data.title) || null,
                        company: cleanText(data.company) || null,
                        location: cleanText(data.location) || null,
                        salary: cleanText(data.salary) || null,
                        contract_type: cleanText(data.contract_type) || null,
                        date_posted: cleanText(data.date_posted) || null,
                        description_html: data.description_html || null,
                        description_text: cleanText(data.description_text) || null,
                        url: request.url,
                    };

                    if (validateJobItem(item)) {
                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(
                            `Saved job #${saved}: ${item.title} (${item.company || 'Unknown company'})`,
                        );
                        break; // Success, exit retry loop
                    } else {
                        throw new Error('Invalid job data extracted');
                    }

                } catch (err) {
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        crawlerLog.error(`DETAIL handler failed after ${maxRetries} retries ${request.url}: ${err.message}`);
                    } else {
                        crawlerLog.warning(`DETAIL handler retry ${retryCount}/${maxRetries} ${request.url}: ${err.message}`);
                        await page.waitForTimeout(1000 * retryCount); // Exponential backoff
                    }
                }
            }
        },
    });

    // ---------- RUN HYBRID FLOW ----------

    log.info(
        `Starting HYBRID scraper with ${initialUrls.length} initial URL(s); target=${RESULTS_WANTED}, maxPages=${MAX_PAGES}`,
    );
    initialUrls.forEach((u, i) => log.info(`Initial URL ${i + 1}: ${u}`));

    log.info('Phase 1: CheerioCrawler (LIST pages, fast)');
    await cheerioCrawler.run(
        initialUrls.map((u) => ({
            url: u,
            userData: { label: 'LIST', pageNo: 1 },
        })),
    );

    const detailArray = Array.from(detailUrls);
    log.info(`LIST phase finished. Detail URLs collected: ${detailArray.length}`);

    if (collectDetails && detailArray.length > 0) {
        log.info('Phase 2: PlaywrightCrawler (DETAIL pages, high concurrency)');
        await playwrightCrawler.run(
            detailArray.map((u) => ({
                url: u,
            })),
        );
    } else if (collectDetails) {
        log.warning('DETAIL phase skipped: no detail URLs were collected.');
    }

    log.info('=== HYBRID SCRAPING COMPLETED ===');
    log.info(`Total jobs saved: ${saved}`);
    log.info(`Target was: ${RESULTS_WANTED}`);
    if (saved === 0) {
        log.error(
            'WARNING: No jobs were scraped. Check selectors, network issues, or recent changes on RozeePk.',
        );
    } else {
        log.info(`Successfully scraped ${saved} jobs from RozeePk.`);
    }
});
