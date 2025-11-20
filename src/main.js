import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ----------------- Helpers -----------------

const toAbs = (href, base = 'https://www.rozee.pk') => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const cleanText = (text) => {
    if (!text) return '';
    return text
        .replace(/\s+/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
};

const parseNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
};

const extractJobIdFromUrl = (url) => {
    try {
        const u = new URL(url);
        const match = u.pathname.match(/(\d+)(?:\/)?$/);
        return match ? match[1] : u.pathname;
    } catch {
        return null;
    }
};

const validateJobItem = (item) => {
    if (!item) return false;
    if (!item.title || !item.url) return false;
    if (!item.company && !item.location) return false;
    return true;
};

const buildStartUrl = (kw, loc, cat) => {
    let path = 'q/all';
    if (kw && kw.trim()) {
        path = `q/${encodeURIComponent(kw.trim())}`;
    }
    // NOTE: location & category can be wired in here if Rozee search supports it.
    return `https://www.rozee.pk/job/jsearch/${path}/fc/1`;
};

const buildNextPageUrl = (currentUrl, nextPageNo) => {
    try {
        const url = new URL(currentUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        const fcIndex = parts.indexOf('fc');
        if (fcIndex !== -1 && parts.length > fcIndex + 1) {
            parts[fcIndex + 1] = String(nextPageNo);
            url.pathname = '/' + parts.join('/');
            return url.toString();
        }
        // Fallback: simple ?page=n
        url.searchParams.set('page', String(nextPageNo));
        return url.toString();
    } catch {
        return null;
    }
};

// ----------------- MAIN -----------------

Actor.main(async () => {
    // Reduce noise – show only useful info / warnings
    log.setLevel(log.LEVELS.INFO);

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
        proxyConfiguration, // passed through to Apify proxy
    } = input;

    const RESULTS_WANTED = parseNumber(RESULTS_WANTED_RAW, 100);
    const MAX_PAGES = parseNumber(MAX_PAGES_RAW, 999);

    const requestQueue = await Actor.openRequestQueue();

    const startRequests = [];

    if (Array.isArray(startUrls) && startUrls.length > 0) {
        for (const req of startUrls) {
            if (!req || !req.url) continue;
            startRequests.push({
                url: req.url,
                userData: { label: 'LIST', pageNo: 1 },
            });
        }
    } else if (typeof startUrl === 'string' && startUrl.trim()) {
        startRequests.push({
            url: startUrl.trim(),
            userData: { label: 'LIST', pageNo: 1 },
        });
    } else if (typeof url === 'string' && url.trim()) {
        startRequests.push({
            url: url.trim(),
            userData: { label: 'LIST', pageNo: 1 },
        });
    } else {
        const searchUrl = buildStartUrl(keyword, location, category);
        startRequests.push({
            url: searchUrl,
            userData: { label: 'LIST', pageNo: 1 },
        });
    }

    for (const req of startRequests) {
        await requestQueue.addRequest(req);
    }

    // IMPORTANT: always call createProxyConfiguration so Apify UI settings are used.
    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

    let saved = 0;
    let detailEnqueued = 0;
    const seenJobIds = new Set();

    log.info(`Rozee.pk Playwright scraper starting | target=${RESULTS_WANTED}, maxPages=${MAX_PAGES}`);

    const crawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxyConfig,

        // Use real Chrome for a more realistic fingerprint
        launchContext: {
            useChrome: true,
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            },
        },

        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: {
            maxPoolSize: 20,
            sessionOptions: {
                maxUsageCount: 50,
                maxAgeSecs: 24 * 60 * 60,
            },
        },

        maxConcurrency: 10,
        minConcurrency: 2,
        maxRequestRetries: 2,
        navigationTimeoutSecs: 45,
        requestHandlerTimeoutSecs: 70,

        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                // Random-ish viewport
                await page.setViewportSize({
                    width: 1280 + Math.floor(Math.random() * 200),
                    height: 720 + Math.floor(Math.random() * 200),
                });

                // Light resource blocking
                await page.route('**/*', (route) => {
                    const req = route.request();
                    const type = req.resourceType();
                    if (['image', 'media', 'font'].includes(type)) {
                        return route.abort();
                    }
                    return route.continue();
                });

                gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],

        requestHandler: async ({ page, request, log: crawlerLog }) => {
            const label = request.userData.label || 'LIST';

            if (saved >= RESULTS_WANTED && label === 'LIST') {
                crawlerLog.info('Target reached; skipping further LIST pages.');
                return;
            }

            // ----- LIST PAGES -----
            if (label === 'LIST') {
                const pageNo = request.userData.pageNo || 1;

                try {
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForTimeout(1000 + Math.random() * 1000);
                } catch {
                    crawlerLog.warning(`LIST page did not reach DOMContentLoaded in time: ${request.url}`);
                }

                // Quick status check: if page is a 403 error template, stop early.
                const isForbidden = await page.evaluate(() => {
                    return (
                        document.title.toLowerCase().includes('forbidden') ||
                        document.body.innerText.trim().startsWith('403') ||
                        document.body.innerText.toLowerCase().includes('access denied')
                    );
                });
                if (isForbidden) {
                    crawlerLog.warning(`LIST page appears forbidden (403 content): ${request.url}`);
                    return;
                }

                let jobUrls = [];
                try {
                    jobUrls = await page.$$eval('a[href]', (anchors) => {
                        const urls = new Set();
                        for (const a of anchors) {
                            const href = a.getAttribute('href') || '';
                            if (!href) continue;

                            if (
                                href.includes('-jobs-') ||
                                /\/job\/\w/i.test(href) ||
                                /jobs-\d+$/i.test(href)
                            ) {
                                urls.add(href);
                            }
                        }
                        return Array.from(urls);
                    });
                } catch (err) {
                    crawlerLog.exception(err, 'Failed to extract job links from LIST page.');
                }

                let newDetailRequests = 0;
                for (const href of jobUrls) {
                    if (saved + detailEnqueued >= RESULTS_WANTED) break;

                    const absUrl = toAbs(href, request.url);
                    if (!absUrl) continue;

                    const jobId = extractJobIdFromUrl(absUrl);
                    if (!jobId || seenJobIds.has(jobId)) continue;

                    seenJobIds.add(jobId);

                    await requestQueue.addRequest({
                        url: absUrl,
                        userData: {
                            label: 'DETAIL',
                            jobId,
                        },
                    });
                    detailEnqueued += 1;
                    newDetailRequests += 1;
                }

                crawlerLog.info(
                    `LIST #${pageNo} | found=${jobUrls.length}, enqueuedDetails=${newDetailRequests}, totalSaved=${saved}`,
                );

                // Pagination
                if (pageNo < MAX_PAGES && saved + detailEnqueued < RESULTS_WANTED) {
                    const nextUrl = buildNextPageUrl(request.url, pageNo + 1);
                    if (nextUrl) {
                        await requestQueue.addRequest({
                            url: nextUrl,
                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                            uniqueKey: `list-${pageNo + 1}-${nextUrl}`,
                        });
                    }
                }

                return;
            }

            // ----- DETAIL PAGES -----
            if (label === 'DETAIL') {
                if (!collectDetails) return;

                try {
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForTimeout(500 + Math.random() * 1000);
                } catch {
                    crawlerLog.warning(`DETAIL page did not reach DOMContentLoaded in time: ${request.url}`);
                }

                let jobRaw = {};
                try {
                    jobRaw = await page.evaluate(() => {
                        const result = {};

                        // 1) JSON-LD JobPosting
                        try {
                            const scripts = Array.from(
                                document.querySelectorAll('script[type="application/ld+json"]'),
                            );
                            for (const script of scripts) {
                                let json;
                                try {
                                    json = JSON.parse(script.textContent.trim());
                                } catch {
                                    continue;
                                }
                                const items = Array.isArray(json) ? json : [json];
                                for (const item of items) {
                                    if (item['@type'] === 'JobPosting') {
                                        result.title = result.title || item.title || null;

                                        if (item.hiringOrganization) {
                                            const org = item.hiringOrganization;
                                            result.company =
                                                result.company ||
                                                org.name ||
                                                (typeof org === 'string' ? org : null);
                                        }

                                        const addr = item.jobLocation?.address;
                                        if (addr && !result.location) {
                                            const parts = [
                                                addr.streetAddress,
                                                addr.addressLocality,
                                                addr.addressRegion,
                                                addr.postalCode,
                                                addr.addressCountry,
                                            ].filter(Boolean);
                                            if (parts.length) {
                                                result.location = parts.join(', ');
                                            }
                                        }

                                        const baseSalary = item.baseSalary;
                                        if (baseSalary && !result.salary) {
                                            const val = baseSalary.value;
                                            if (val && typeof val === 'object') {
                                                const { minValue, maxValue, value, currency } = val;
                                                const range =
                                                    minValue && maxValue
                                                        ? `${minValue}–${maxValue}`
                                                        : value ?? minValue ?? maxValue;
                                                result.salary = `${currency || ''} ${range || ''}`.trim();
                                            } else if (val) {
                                                result.salary = String(val);
                                            }
                                        }

                                        if (item.employmentType && !result.contract_type) {
                                            result.contract_type = item.employmentType;
                                        }

                                        if (item.description && !result.description_html) {
                                            result.description_html = item.description;
                                        }

                                        if (item.datePosted && !result.date_posted) {
                                            result.date_posted = item.datePosted;
                                        }
                                    }
                                }
                            }
                        } catch {
                            // ignore JSON-LD errors
                        }

                        const getText = (sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.textContent.trim() : null;
                        };

                        if (!result.title) {
                            result.title =
                                getText('h1') ||
                                getText('h2') ||
                                getText('.job-title') ||
                                getText('[itemprop="title"]');
                        }

                        if (!result.company) {
                            result.company =
                                getText('.company-name') ||
                                getText('.cp-name') ||
                                getText('[itemprop="hiringOrganization"]');
                        }

                        if (!result.location) {
                            result.location =
                                getText('.location') ||
                                getText('.job-location') ||
                                getText('[itemprop="jobLocation"]');
                        }

                        if (!result.description_html) {
                            const descEl =
                                document.querySelector('.job-description') ||
                                document.querySelector('#job-description') ||
                                document.querySelector('[itemprop="description"]');
                            if (descEl) {
                                result.description_html = descEl.innerHTML.trim();
                            }
                        }

                        return result;
                    });
                } catch (e) {
                    crawlerLog.exception(e, `Failed to extract job data from DETAIL page: ${request.url}`);
                    return;
                }

                const job = {
                    source: 'rozee.pk',
                    url: request.url,
                    title: cleanText(jobRaw.title),
                    company: cleanText(jobRaw.company),
                    location: cleanText(jobRaw.location),
                    salary: cleanText(jobRaw.salary),
                    contract_type: cleanText(jobRaw.contract_type),
                    description_html: jobRaw.description_html || null,
                    date_posted: jobRaw.date_posted || null,
                };

                if (!validateJobItem(job)) {
                    crawlerLog.warning(`Skipping invalid job from ${request.url}`);
                    return;
                }

                await Dataset.pushData(job);
                saved += 1;

                if (saved % 10 === 0) {
                    crawlerLog.info(`Saved ${saved} jobs so far.`);
                }

                return;
            }

            crawlerLog.warning(`Unknown label "${label}" for URL: ${request.url}`);
        },

        failedRequestHandler: async ({ request, error, log: crawlerLog }) => {
            crawlerLog.exception(error, `Request failed for ${request.url}`);
        },
    });

    await crawler.run();

    log.info(`Scraping finished. Total jobs saved: ${saved} (target was ${RESULTS_WANTED}).`);

    if (saved === 0) {
        log.error(
            'WARNING: No jobs were scraped. The site is returning errors (e.g. 403). Check your proxy/IP setup and whether Rozee has changed access rules.',
        );
    } else {
        log.info(`Successfully scraped ${saved} jobs from Rozee.pk.`);
    }
});
