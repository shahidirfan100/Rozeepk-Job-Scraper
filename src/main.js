// Rozee.pk Playwright-only scraper: high stealth, high performance
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

// Convert description HTML to readable text
const htmlToText = (html) => {
    if (!html) return '';
    let text = html;

    text = text.replace(/<\s*br\s*\/?>/gi, '\n');
    text = text.replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' '); // strip remaining tags
    text = text.replace(/\r/g, '');
    text = text.replace(/\n\s*\n+/g, '\n\n');

    return cleanText(text);
};

// "Lahore, Lahore, Punjab, 54000, [object Object]" -> "Lahore, Punjab"
const normalizeLocation = (loc) => {
    if (!loc) return '';
    const parts = loc
        .split(',')
        .map((p) => cleanText(p))
        .filter(Boolean);

    const unique = [];
    for (const p of parts) {
        if (!unique.includes(p)) unique.push(p);
    }

    // Prefer city + region
    const trimmed = unique.slice(0, 2);
    return trimmed.join(', ');
};

// ----------------- MAIN -----------------

Actor.main(async () => {
    // Concise but useful logs
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
        proxyConfiguration, // Apify proxy / residential config
    } = input;

    const RESULTS_WANTED = parseNumber(RESULTS_WANTED_RAW, 100);
    const MAX_PAGES = parseNumber(MAX_PAGES_RAW, 999);

    const requestQueue = await Actor.openRequestQueue();

    // ---------- Initial URLs ----------

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

    // Use Apify proxy / passed proxy configuration
    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

    let saved = 0;
    let detailEnqueued = 0;
    const seenJobIds = new Set();

    log.info(`Rozee.pk Playwright scraper starting | target=${RESULTS_WANTED}, maxPages=${MAX_PAGES}`);

    const crawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxyConfig,

        // Headless Chromium with stealthy flags
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                ],
            },
        },

        // Anti-blocking / session management
        useSessionPool: true,
        persistCookiesPerSession: true,
        retryOnBlocked: true,
        sessionPoolOptions: {
            maxPoolSize: 40, // 4GB RAM allows more sessions
            sessionOptions: {
                maxUsageCount: 20,
                maxAgeSecs: 6 * 60 * 60,
                maxErrorScore: 3,
            },
        },

        // 4 GB → we can afford higher concurrency; AutoscaledPool still respects CPU/mem
        maxConcurrency: 16,
        minConcurrency: 4,
        maxRequestRetries: 2,
        navigationTimeoutSecs: 25,
        requestHandlerTimeoutSecs: 50,

        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                // Random-ish viewport for each page
                await page.setViewportSize({
                    width: 1280 + Math.floor(Math.random() * 200),
                    height: 720 + Math.floor(Math.random() * 200),
                });

                // Block heavy resources for speed
                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                        return route.abort();
                    }
                    return route.continue();
                });

                gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],

        requestHandler: async ({ page, request, session, log: crawlerLog }) => {
            const label = request.userData.label || 'LIST';

            if (saved >= RESULTS_WANTED && label === 'LIST') {
                crawlerLog.info('Target reached; skipping further LIST pages.');
                session?.markGood();
                return;
            }

            // ---------- LIST PAGES ----------
            if (label === 'LIST') {
                const pageNo = request.userData.pageNo || 1;

                try {
                    // Wait for DOM + actual job links instead of blind sleeps
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForSelector('a[href*="-jobs-"]', { timeout: 10000 });
                } catch {
                    crawlerLog.warning(
                        `LIST page did not load job links in time (possible block): ${request.url}`,
                    );
                }

                // Content-based block detection (403 pages returned as 200)
                const looksForbidden = await page.evaluate(() => {
                    const bodyText = document.body?.innerText?.toLowerCase() || '';
                    return (
                        document.title.toLowerCase().includes('forbidden') ||
                        bodyText.startsWith('403') ||
                        bodyText.includes('access denied') ||
                        bodyText.includes('request blocked')
                    );
                });
                if (looksForbidden) {
                    crawlerLog.warning(`LIST page appears forbidden (content-based): ${request.url}`);
                    session?.markBad();
                    return;
                }

                let jobUrls = [];
                try {
                    jobUrls = await page.$$eval('a[href]', (anchors) => {
                        const urls = new Set();
                        for (const a of anchors) {
                            const href = a.getAttribute('href') || '';
                            if (!href) continue;
                            // Rozee job detail links typically "...-jobs-<id>"
                            if (/-jobs-\d+/i.test(href)) {
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

                session?.markGood();
                return;
            }

            // ---------- DETAIL PAGES ----------
            if (label === 'DETAIL') {
                if (!collectDetails) {
                    session?.markGood();
                    return;
                }

                try {
                    await page.waitForLoadState('domcontentloaded');
                    // Small jitter to mimic user-y delay, not huge
                    await page.waitForTimeout(300 + Math.random() * 400);
                } catch {
                    crawlerLog.warning(
                        `DETAIL page did not reach DOMContentLoaded in time: ${request.url}`,
                    );
                }

                let jobRaw = {};
                try {
                    jobRaw = await page.evaluate(() => {
                        const result = {};

                        const normVal = (v) => {
                            if (!v) return null;
                            if (typeof v === 'string') return v.trim();
                            if (typeof v === 'object' && v.name) return String(v.name).trim();
                            return null;
                        };

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
                                                normVal(org) ||
                                                normVal(org.name) ||
                                                null;
                                        }

                                        const jobLoc = item.jobLocation;
                                        if (jobLoc && !result.location) {
                                            const addr = Array.isArray(jobLoc)
                                                ? jobLoc[0]?.address
                                                : jobLoc.address;
                                            if (addr) {
                                                const parts = [
                                                    normVal(addr.addressLocality),
                                                    normVal(addr.addressRegion),
                                                    normVal(addr.addressCountry),
                                                ].filter(Boolean);
                                                if (parts.length) {
                                                    const unique = [];
                                                    for (const p of parts) {
                                                        if (!unique.includes(p)) unique.push(p);
                                                    }
                                                    result.location = unique.join(', ');
                                                }
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
                            const loc =
                                getText('.location') ||
                                getText('.job-location') ||
                                getText('[itemprop="jobLocation"]');
                            if (loc) result.location = loc;
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
                    session?.markBad();
                    return;
                }

                const rawLocation = jobRaw.location || '';
                const normalizedLocation = normalizeLocation(rawLocation);

                const job = {
                    source: 'rozee.pk',
                    url: request.url,
                    title: cleanText(jobRaw.title),
                    company: cleanText(jobRaw.company),
                    location: normalizedLocation,
                    salary: cleanText(jobRaw.salary),
                    contract_type: cleanText(jobRaw.contract_type),
                    description_html: jobRaw.description_html || null,
                    description_text: htmlToText(jobRaw.description_html || ''),
                    date_posted: jobRaw.date_posted || null,
                };

                if (!validateJobItem(job)) {
                    crawlerLog.warning(`Skipping invalid job from ${request.url}`);
                    session?.markBad();
                    return;
                }

                await Dataset.pushData(job);
                saved += 1;

                if (saved % 10 === 0) {
                    crawlerLog.info(`Saved ${saved} jobs so far.`);
                }

                session?.markGood();
                return;
            }

            crawlerLog.warning(`Unknown label "${label}" for URL: ${request.url}`);
            session?.markBad();
        },

        failedRequestHandler: async ({ request, error, session, log: crawlerLog }) => {
            crawlerLog.exception(error, `Request failed for ${request.url}`);
            if (session) session.markBad();
        },
    });

    await crawler.run();

    log.info(`Scraping finished. Total jobs saved: ${saved} (target was ${RESULTS_WANTED}).`);

    if (saved === 0) {
        log.error(
            'WARNING: No jobs were scraped. The site may be blocking requests or has changed its structure.',
        );
    } else {
        log.info(`Successfully scraped ${saved} jobs from Rozee.pk.`);
    }
});
