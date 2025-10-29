// Rozee.pk jobs scraper – HTTP-only (CheerioCrawler + gotScraping), no Playwright.
// Strategy:
// 1) Prefer SSR listings (cities, category) to avoid SPA/JS hydration.
// 2) Detect Cloudflare/blocked pages & retire session quickly.
// 3) JSON-LD-first extraction on details, resilient DOM fallbacks.
// 4) Strong headers + TLS via got-scraping header generator.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        // Search & limits
        keyword = '',
        datePosted = 'all',
        results_wanted: MAX_ITEMS_RAW = 80,
        max_pages: MAX_PAGES_RAW = 25,
        collectDetails = true,

        // Start points (we’ll add robust defaults)
        startUrl: startUrls = [],
        url,

        // Anti-block tuning
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

    // date filter
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

    // Parse detail URLs from JSON-LD / embedded state / DOM
    function parseJobDetailLinks($, base) {
        const links = new Set();

        // JSON-LD (ItemList or JobPosting)
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const blk = $(el).contents().text().trim();
                if (!blk) return;
                const data = JSON.parse(blk);
                const arr = Array.isArray(data) ? data : [data];
                for (const item of arr) {
                    const type = (item?.['@type'] || '').toLowerCase();
                    if (type === 'jobposting') {
                        const u = toAbs(item.url || item.titleUrl || item.applyUrl || '', base);
                        if (u && /jobs-\d{5,}/.test(u)) links.add(u.split('?')[0]);
                    }
                    if (type === 'itemlist' && Array.isArray(item.itemListElement)) {
                        for (const it of item.itemListElement) {
                            const ent = it.item || it;
                            const u = toAbs(ent?.url || ent?.titleUrl || '', base);
                            if (u && /jobs-\d{5,}/.test(u)) links.add(u.split('?')[0]);
                        }
                    }
                }
            } catch {}
        });

        // Generic anchors
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (/jobs-\d{5,}/.test(href)) {
                const u = toAbs(href, base);
                if (u) links.add(u.split('?')[0]);
            }
        });

        // Sanitize
        return [...links].filter(u =>
            !/\/company\//i.test(u) && !/\/jsearch\//i.test(u) && !/\/(login|apply)/i.test(u)
        );
    }

    // Pagination discovery
    function findNextPage($, base) {
        const relNext = $('link[rel="next"]').attr('href');
        if (relNext) return toAbs(relNext, base);

        const nextByText = $('a:contains("Next"), a:contains("›"), a:contains("»"), [class*="next"]').attr('href');
        if (nextByText) return toAbs(nextByText, base);

        const current = $('.pagination .active, .pagination .current, [aria-current="page"], .page-item.active').first().text().trim();
        if (current && !isNaN(+current)) {
            const nextPage = String(+current + 1);
            const nextLink = $(`.pagination a:contains("${nextPage}")`).attr('href');
            if (nextLink) return toAbs(nextLink, base);
        }

        // Query-param fallback
        let fallback = null;
        $('a[href*="page="], a[href*="p="], a[href*="fpn="]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && /(\?|&)(page|p|fpn)=\d+/.test(href)) {
                const u = toAbs(href, base);
                if (u) fallback = u;
            }
        });
        return fallback;
    }

    // ---------- seeds ----------
    const seeds = new Set();

    // Good SSR entry points:
    // A) Jobs-by-city hub → many city lists (SSR)
    seeds.add('https://www.rozee.pk/EN/jobs-by-city'); // hub of cities (SSR).  // cite
    // B) Category home (SSR w/ job cards)
    seeds.add('https://www.rozee.pk/category/Home/');  // cite

    // C) Optional: user-provided URL(s)
    const inputUrls = Array.isArray(startUrls) ? startUrls : (startUrls ? [startUrls] : []);
    inputUrls.forEach(u => { if (typeof u === 'string' && u.includes('rozee.pk')) seeds.add(u); });
    if (url && typeof url === 'string' && url.includes('rozee.pk')) seeds.add(url);

    // D) Best-effort keyword search page (may be SPA/guarded)
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
        sessionPoolOptions: {
            maxPoolSize: 15,
            sessionOptions: { maxUsageCount: 20 },
        },
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 90,

        // Strong HTTP fingerprint via got-scraping
        preNavigationHooks: [
            async ({ request, session }, gotOptions) => {
                // Per-session stable UA
                const ua = session?.userData?.ua ||
                    (session.userData.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${110 + Math.floor(Math.random() * 20)}.0.0.0 Safari/537.36`);

                request.headers = {
                    'user-agent': ua,
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'upgrade-insecure-requests': '1',
                    'sec-fetch-site': 'same-origin',
                    'sec-fetch-mode': 'navigate',
                    'sec-fetch-dest': 'document',
                };

                // got-scraping tuning
                gotOptions.throwHttpErrors = false;
                gotOptions.http2 = true; // real browsers prefer h2 here
                gotOptions.decompress = true;
                gotOptions.cookieJar = session?.cookieJar;
                // Header generator (JA3/TLS-like)
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

        postNavigationHooks: [
            async ({ response, session, $, request, log: clog }) => {
                const status = response?.statusCode || 200;
                if ([403, 429, 503].includes(status)) {
                    clog.warning(`HTTP ${status} at ${request.url}, retiring session.`);
                    session?.retire?.();
                }
                if ($ && looksLikeCfBlock($)) {
                    clog.warning(`Cloudflare/verification page at ${request.url}, retiring session.`);
                    session?.retire?.();
                    // Force fail to trigger retry with a new session
                    throw new Error('Detected Cloudflare interstitial');
                }
            },
        ],

        requestHandler: async ({ request, $, enqueueLinks, response, session, log: clog }) => {
            const label = request.userData?.label || 'GEN';
            const pageNo = request.userData?.pageNo || 1;
            const status = response?.statusCode || 200;

            if ([403, 429, 503].includes(status) || !$) {
                session?.retire?.();
                throw new Error(`Blocked or empty DOM on ${request.url} (HTTP ${status})`);
            }

            // 1) HUB: /EN/jobs-by-city  → enqueue city pages
            if (label === 'HUB_CITY') {
                clog.info(`Parsing city hub: ${request.url}`);
                const cityUrls = [];
                $('a[href*="/jobs-in-"]').each((_, el) => {
                    const u = toAbs($(el).attr('href'), request.url);
                    if (u && /\/jobs-in-[^/]+\/?/.test(u)) cityUrls.push(u);
                });
                // Dedup + enqueue
                const uniq = [...new Set(cityUrls)].slice(0, 200); // cap
                if (uniq.length) {
                    clog.info(`Enqueueing ${uniq.length} city pages`);
                    await enqueueLinks({ urls: uniq.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })) });
                }
                return;
            }

            // 2) CATEGORY HOME: /category/Home/  → treat as LIST
            if (label === 'CAT_HOME') {
                clog.info(`Parsing category home as listing: ${request.url}`);
                // fall through to LIST logic below by not returning
            }

            // 3) LIST pages (city/category/search)
            if (label === 'LIST' || label === 'CAT_HOME' || label === 'GEN') {
                clog.info(`LIST page ${pageNo}: ${request.url}`);

                // If CF page slipped through, bail
                if (looksLikeCfBlock($)) {
                    session?.retire?.();
                    throw new Error('Detected Cloudflare on LIST page');
                }

                const jobLinks = parseJobDetailLinks($, request.url);
                clog.info(`Found ${jobLinks.length} job links`);
                if (collectDetails && jobLinks.length > 0) {
                    const remaining = MAX_ITEMS - saved;
                    const toEnqueue = jobLinks.slice(0, remaining);
                    if (toEnqueue.length) {
                        await enqueueLinks({
                            urls: toEnqueue.map(u => ({ url: u, userData: { label: 'DETAIL' } })),
                        });
                    }
                }

                if (saved < MAX_ITEMS && pageNo < MAX_PAGES) {
                    const next = findNextPage($, request.url);
                    if (next) {
                        clog.info(`Enqueue next page ${pageNo + 1}: ${next}`);
                        await enqueueLinks({ urls: [{ url: next, userData: { label: 'LIST', pageNo: pageNo + 1 } }] });
                    }
                }

                await sleep(jitter());
                return;
            }

            // 4) DETAIL pages
            if (label === 'DETAIL') {
                if (saved >= MAX_ITEMS) return;

                if (looksLikeCfBlock($)) {
                    session?.retire?.();
                    throw new Error('Detected Cloudflare on DETAIL page');
                }

                try {
                    let title, company, jobLocation, datePostedText, jobType, salary, experience, description, category;
                    const skills = new Set();

                    // JSON-LD first
                    $('script[type="application/ld+json"]').each((_, el) => {
                        try {
                            const data = JSON.parse($(el).contents().text().trim());
                            const arr = Array.isArray(data) ? data : [data];
                            for (const item of arr) {
                                if ((item?.['@type'] || '').toLowerCase() === 'jobposting') {
                                    title = title || item.title;
                                    company = company || item.hiringOrganization?.name;
                                    jobLocation = jobLocation || item.jobLocation?.address?.addressLocality
                                        || item.jobLocation?.address?.addressRegion
                                        || item.jobLocation?.address?.addressCountry;
                                    datePostedText = datePostedText || item.datePosted || item.datePublished;
                                    jobType = jobType || (Array.isArray(item.employmentType) ? item.employmentType.join(', ') : item.employmentType);
                                    salary = salary || item.baseSalary?.value?.value || item.baseSalary?.value?.minValue;
                                    experience = experience || item.experienceRequirements || item.qualifications;
                                    description = description || cleanText(item.description);
                                    category = category || item.industry || item.occupationalCategory;

                                    const skillsBlock = item.skills || item.skill || [];
                                    (Array.isArray(skillsBlock) ? skillsBlock : [skillsBlock]).forEach(s => {
                                        if (typeof s === 'string') skills.add(s.trim());
                                        if (s?.name) skills.add(String(s.name).trim());
                                    });
                                }
                            }
                        } catch {}
                    });

                    // DOM fallbacks
                    if (!title) title = $('h1').first().text().trim() || $('title').text().split('-')[0]?.trim();
                    if (!company) company = $('a[href*="/company/"]').first().text().trim() || $('[class*="company"]').first().text().trim();
                    if (!jobLocation) jobLocation = $('[class*="location"], [class*="city"]').first().text().trim() || 'Pakistan';
                    if (!description || description.length < 40) {
                        description = cleanText($('[class*="description"], [id*="description"], section:contains("Job Description")').first().html()) ||
                                      cleanText($('body').html()).slice(0, 2800);
                    }
                    if (!salary) {
                        const sal = $.html().match(/PKR?\.?\s*([\d,.]+(?:\s*-\s*[\d,.]+)?)/i);
                        if (sal) salary = sal[0].trim();
                    }
                    if (!experience) {
                        const ex = $.html().match(/(\d+)\s*(?:\+?\s*)?(Years?|Year)/i);
                        if (ex) experience = ex[0].trim();
                    }

                    if (!isWithinDateFilter(datePostedText, datePosted)) {
                        clog.info(`Skip (date filter ${datePosted}): ${datePostedText}`);
                        return;
                    }

                    const job = {
                        url: request.url,
                        title: title || 'Unknown Title',
                        company: company || 'Unknown Company',
                        location: jobLocation || 'Pakistan',
                        salary: salary || 'Not specified',
                        experience: experience || 'Not specified',
                        jobType: jobType || 'Not specified',
                        category: category || 'Not specified',
                        description: description || 'No description',
                        skills: Array.from(skills).join(', ') || 'Not specified',
                        datePosted: datePostedText || 'Unknown',
                        scrapedAt: new Date().toISOString(),
                    };

                    if (!job.title || !job.company) {
                        failedUrls.push({ url: request.url, reason: 'Missing critical fields' });
                        return;
                    }

                    await Dataset.pushData(job);
                    saved++;
                    clog.info(`Saved job ${saved}/${MAX_ITEMS}: ${job.title} @ ${job.company}`);
                    await sleep(jitter());
                } catch (err) {
                    clog.error(`DETAIL error on ${request.url}: ${err?.message}`);
                    failedUrls.push({ url: request.url, reason: err?.message || String(err) });
                    throw err;
                }
            }
        },

        failedRequestHandler: async ({ request, error, session, log: clog }) => {
            clog.error(`Request failed: ${request.url}`, { error: error?.message });
            session?.retire?.();
            failedUrls.push({ url: request.url, reason: error?.message });
        },
    });

    // Queue seeds with specific labels
    const startRequests = [];
    for (const s of seeds) {
        if (s.includes('/EN/jobs-by-city')) {
            startRequests.push({ url: s, userData: { label: 'HUB_CITY' } });
        } else if (s.includes('/category/Home')) {
            startRequests.push({ url: s, userData: { label: 'CAT_HOME', pageNo: 1 } });
        } else if (s.includes('/job/jsearch/')) {
            startRequests.push({ url: s, userData: { label: 'LIST', pageNo: 1 } });
        } else {
            startRequests.push({ url: s, userData: { label: 'GEN', pageNo: 1 } });
        }
    }

    await crawler.run(startRequests);

    log.info('Done', { totalJobsSaved: saved, failedUrls: failedUrls.length, target: MAX_ITEMS });
    if (failedUrls.length) log.warning('Sample failures', { examples: failedUrls.slice(0, 10) });
}

try {
    await main();
} catch (err) {
    log.error('Fatal error in main:', err);
    throw err;
} finally {
    await Actor.exit();
}
