// Rozee.pk jobs scraper - Hardened CheerioCrawler implementation
// Includes fixes for modern Apify SDK (replaces Actor.utils.sleep with Crawlee's sleep)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        datePosted = 'all',
        results_wanted: MAX_ITEMS_RAW = 50,
        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true,
        startUrl: startUrls = ['https://www.rozee.pk/job/jsearch/q/all'],
        url,
        proxyConfiguration,
        minDelayMs = 800,
        maxDelayMs = 1800,
    } = input;

    const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

    log.info('Actor configuration', { MAX_ITEMS, MAX_PAGES, collectDetails, keyword, location, datePosted });

    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try { return new URL(href, base).href.split('#')[0]; } catch { return null; }
    };

    const cleanText = (html) => {
        if (!html) return '';
        const $ = cheerioLoad(html);
        $('script, style, noscript, iframe').remove();
        return $.root().text().replace(/\s+/g, ' ').trim();
    };

    const isWithinDateFilter = (dateStr, filter) => {
        if (!dateStr || filter === 'all') return true;
        const now = new Date();
        const cutoffHours = filter === '24hours' ? 24 : filter === '7days' ? 168 : filter === '30days' ? 720 : 0;
        if (!cutoffHours) return true;

        const s = (dateStr || '').toLowerCase();
        const hoursMatch = s.match(/(\d+)\s*hours?/i);
        if (hoursMatch) return parseInt(hoursMatch[1], 10) <= cutoffHours;

        const daysMatch = s.match(/(\d+)\s*days?/i);
        if (daysMatch) return (parseInt(daysMatch[1], 10) * 24) <= cutoffHours;

        if (s.includes('today')) return true;
        if (s.includes('yesterday')) return cutoffHours >= 24;

        const dateMatch = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),\s+(\d{4})/i);
        if (dateMatch) {
            const jobDate = new Date(dateMatch[0]);
            const diffMs = now - jobDate;
            return (diffMs / (1000 * 60 * 60)) <= cutoffHours;
        }
        return true;
    };

    const buildStartUrl = () => {
        if (keyword && keyword.trim()) {
            const cleanKeyword = keyword.trim().toLowerCase().replace(/\s+/g, '-');
            return 'https://www.rozee.pk/job/jsearch/q/' + encodeURIComponent(cleanKeyword);
        }
        return 'https://www.rozee.pk/job/jsearch/q/all';
    };

    let inputUrls = Array.isArray(startUrls) ? [...startUrls] : [startUrls];
    inputUrls = inputUrls.filter(u => u && typeof u === 'string' && u.includes('rozee.pk'));

    const initial = [];
    if (inputUrls.length) initial.push(...inputUrls);
    if (url && typeof url === 'string' && url.includes('rozee.pk')) initial.push(url);
    if (initial.length === 0) initial.push(buildStartUrl());

    log.info('Starting with ' + initial.length + ' URL(s)', { urls: initial });

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

    let saved = 0;
    const failedUrls = [];

    function parseJobsFromJsonLd($, base) {
        const jobs = [];
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).contents().text().trim());
                const list = Array.isArray(json) ? json : [json];
                for (const item of list) {
                    if (!item) continue;
                    if ((item['@type'] || '').toLowerCase() === 'jobposting') {
                        const url = toAbs(item.url || item.titleUrl || item.applyUrl || '', base);
                        if (url) jobs.push(url);
                    }
                    if ((item['@type'] || '').toLowerCase() === 'itemlist' && Array.isArray(item.itemListElement)) {
                        for (const it of item.itemListElement) {
                            const ent = it.item || it;
                            const url = toAbs(ent?.url || ent?.titleUrl || '', base);
                            if (url) jobs.push(url);
                        }
                    }
                }
            } catch (_) { }
        });
        return jobs;
    }

    function parseJobsFromEmbeddedState($, base) {
        const jobs = new Set();
        const html = $.html();
        const patterns = [
            /__NEXT_DATA__\W*?=\W*?({[\s\S]*?})\s*</i,
            /window\.__NUXT__\s*=\s*({[\s\S]*?});/i,
            /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i,
        ];
        for (const re of patterns) {
            const m = html.match(re);
            if (m) {
                try {
                    const state = JSON.parse(m[1]);
                    const asString = JSON.stringify(state);
                    const hrefs = asString.match(/https?:\/\/www\.rozee\.pk[^"']+jobs-\d{5,}[^"']*/gi) || [];
                    hrefs.forEach(h => jobs.add(h.replace(/\\\//g, '/')));
                } catch (_) { }
            }
        }
        return Array.from(jobs);
    }

    function findJobLinks($, base) {
        const links = new Set();
        parseJobsFromJsonLd($, base).forEach(u => links.add(u));
        parseJobsFromEmbeddedState($, base).forEach(u => links.add(u));
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (/jobs-\d{5,}/.test(href)) {
                const abs = toAbs(href, base);
                if (abs) links.add(abs.split('?')[0]);
            }
        });
        return [...links].filter(link =>
            !/\/company\//.test(link) && !/\/jsearch\//.test(link) && !/\/(apply|login)/i.test(link)
        );
    }

    function findNextPage($, base) {
        const relNext = $('link[rel="next"]').attr('href');
        if (relNext) return toAbs(relNext, base);
        const nextByText = $('a:contains("Next"), a:contains("›"), a:contains("»"), [class*="next"]').attr('href');
        if (nextByText) return toAbs(nextByText, base);
        const current = $('.pagination .active, [aria-current="page"]').first().text().trim();
        if (current && !isNaN(+current)) {
            const nextPage = String(+current + 1);
            const nextLink = $(`.pagination a:contains("${nextPage}")`).attr('href');
            if (nextLink) return toAbs(nextLink, base);
        }
        let fallback = null;
        $('a[href*="page="], a[href*="p="]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && /(\?|&)page=\d+/.test(href)) {
                const abs = toAbs(href, base);
                if (abs) fallback = abs;
            }
        });
        return fallback;
    }

    const jitter = () => {
        const min = Math.max(0, Number(minDelayMs) || 0);
        const max = Math.max(min, Number(maxDelayMs) || min);
        const span = max - min;
        return min + Math.floor(Math.random() * (span + 1));
    };

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 8,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 15, sessionOptions: { maxUsageCount: 20 } },
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 90,

        requestHandler: async ({ request, $, enqueueLinks, log: crawlerLog, response, session }) => {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;
            const status = response?.statusCode || 200;
            if ([403, 429, 503].includes(status)) {
                crawlerLog.warning(`Blocked (status ${status}) at ${request.url}. Retiring session.`);
                session?.retire?.();
                throw new Error(`Blocked with status ${status}`);
            }

            if (label === 'LIST') {
                crawlerLog.info(`Processing listing page ${pageNo}: ${request.url}`);
                const jobLinks = findJobLinks($, request.url);
                crawlerLog.info(`Found ${jobLinks.length} job links`);
                if (jobLinks.length > 0 && collectDetails) {
                    const remaining = MAX_ITEMS - saved;
                    const toEnqueue = jobLinks.slice(0, remaining);
                    await enqueueLinks({ urls: toEnqueue.map(u => ({ url: u, userData: { label: 'DETAIL' } })) });
                }
                if (saved < MAX_ITEMS && pageNo < MAX_PAGES) {
                    const next = findNextPage($, request.url);
                    if (next) await enqueueLinks({ urls: [{ url: next, userData: { label: 'LIST', pageNo: pageNo + 1 } }] });
                }
                await sleep(jitter());
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= MAX_ITEMS) return;
                try {
                    let title, company, jobLocation, datePostedText, jobType, salary, experience, description, category;
                    const skills = new Set();
                    $('script[type="application/ld+json"]').each((_, el) => {
                        try {
                            const data = JSON.parse($(el).contents().text().trim());
                            const arr = Array.isArray(data) ? data : [data];
                            for (const item of arr) {
                                if ((item?.['@type'] || '').toLowerCase() === 'jobposting') {
                                    title = title || item.title;
                                    company = company || item.hiringOrganization?.name;
                                    jobLocation = jobLocation || item.jobLocation?.address?.addressLocality;
                                    datePostedText = datePostedText || item.datePosted || item.datePublished;
                                    jobType = jobType || item.employmentType;
                                    salary = salary || item.baseSalary?.value?.value;
                                    experience = experience || item.experienceRequirements;
                                    description = description || cleanText(item.description);
                                    category = category || item.industry;
                                }
                            }
                        } catch { }
                    });

                    if (!title) title = $('h1').first().text().trim();
                    if (!company) company = $('a[href*="/company/"]').first().text().trim();
                    if (!jobLocation) jobLocation = $('[class*="location"]').first().text().trim();
                    if (!description) description = cleanText($('[class*="description"]').html());
                    if (!isWithinDateFilter(datePostedText, datePosted)) return;

                    const job = {
                        url: request.url,
                        title: title || 'Unknown',
                        company: company || 'Unknown',
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
                    if (!title || !company) return;
                    await Dataset.pushData(job);
                    saved++;
                    crawlerLog.info(`Saved job ${saved}/${MAX_ITEMS}: ${title}`);
                    await sleep(jitter());
                } catch (err) {
                    crawlerLog.error(`Error extracting ${request.url}: ${err.message}`);
                    failedUrls.push({ url: request.url, reason: err.message });
                }
            }
        },

        failedRequestHandler: async ({ request, error, session }) => {
            log.error(`Request failed: ${request.url}`, { error: error?.message });
            session?.retire?.();
            failedUrls.push({ url: request.url, reason: error?.message });
        },

        preNavigationHooks: [
            async ({ request, session }, gotoOptions) => {
                request.headers = {
                    'user-agent': session?.userData?.ua ||
                        (session.userData.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${100 + Math.floor(Math.random()*15)}.0.0.0 Safari/537.36`),
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                };
                await sleep(jitter());
                gotoOptions.throwHttpErrors = false;
                gotoOptions.timeout = { request: 90000 };
            },
        ],

        postNavigationHooks: [
            async ({ response, session }) => {
                const status = response?.statusCode || 200;
                if ([403, 429].includes(status)) session?.retire?.();
            },
        ],
    });

    await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));

    log.info('Scraping completed', {
        totalJobsSaved: saved,
        failedUrls: failedUrls.length,
        maxItemsTarget: MAX_ITEMS,
    });
}

try {
    await main();
} catch (err) {
    log.error('Fatal error in main:', err);
    throw err;
} finally {
    await Actor.exit();
}
