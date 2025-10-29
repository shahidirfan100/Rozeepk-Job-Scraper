// Rozee.pk jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '', location = '', category = '', maxItems: MAX_ITEMS_RAW = 100,
        max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl: startUrls = ["https://www.rozee.pk/job/jsearch/q/all"], url, proxyConfiguration,
    } = input;

    const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;
    
    log.info('Actor configuration', { MAX_ITEMS, MAX_PAGES, collectDetails });

    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try { return new URL(href, base).href; } catch { return null; }
    };

    const cleanText = (html) => {
        if (!html) return '';
        const $ = cheerioLoad(html);
        $('script, style, noscript, iframe').remove();
        return $.root().text().replace(/\s+/g, ' ').trim();
    };

    const extractDate = (text) => {
        if (!text) return null;
        // Extract date from text like "Posted 12 hours ago", "Posted Oct 28, 2025"
        const match = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/);
        if (match) return match[0];
        return text.trim();
    };

    // Rozee.pk does not use keyword/location/category in URL params for the main job search page
    const buildStartUrl = () => {
        return 'https://www.rozee.pk/job/jsearch/q/all';
    };
    
    if (!Array.isArray(startUrls)) startUrls = [startUrls];
    
    // Filter and validate URLs
        let inputUrls = Array.isArray(startUrls) ? [...startUrls] : [startUrls];
        inputUrls = inputUrls.filter(u => u && typeof u === 'string' && u.includes('rozee.pk'));

    const initial = [];
    if (startUrls.length) initial.push(...startUrls);
    if (url && typeof url === 'string' && url.includes('rozee.pk')) initial.push(url);
    if (!initial.length) initial.push(buildStartUrl());
    
    log.info(`Starting with ${initial.length} URL(s)`, { urls: initial });

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

    let saved = 0;
    const failedUrls = [];

    // Removed extractFromJsonLd, not used for Rozee.pk
    
    function findJobLinks($, base) {
        const links = new Set();
        // Rozee.pk job listings are in <a> tags with hrefs matching pattern: /company-job-title-location-jobs-id
        $('a[href*="-jobs-"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && /\/[^\/]+-jobs-\d+/.test(href)) {
                const abs = toAbs(href, base);
                if (abs && !abs.includes('utm_')) links.add(abs.split('?')[0]); // Remove query params
            }
        });
        return [...links];
    }

    function findNextPage($, base) {
        // Look for Next pagination link
        const nextLink = $('a:contains("Next")').attr('href');
        if (nextLink) return toAbs(nextLink, base);
        
        // Alternative: look for numbered pagination
        const currentPage = $('.pagination a.active, .pagination span.active').text().trim();
        if (currentPage) {
            const nextPage = parseInt(currentPage) + 1;
            const nextPageLink = $(`.pagination a:contains("${nextPage}")`).attr('href');
            if (nextPageLink) return toAbs(nextPageLink, base);
        }
        
        return null;
    }
    
    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 5,
        useSessionPool: true,
        maxConcurrency: 5,
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (label === 'LIST') {
                // Rozee.pk job blocks - find all job detail URLs
                const jobLinks = findJobLinks($, request.url);
                crawlerLog.info(`Found ${jobLinks.length} job links on page ${pageNo}`);
                
                if (collectDetails && jobLinks.length > 0) {
                    const remaining = MAX_ITEMS - saved;
                    const toEnqueue = jobLinks.slice(0, Math.max(0, remaining));
                    if (toEnqueue.length > 0) {
                        await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    }
                }
                
                // Pagination
                if (saved < MAX_ITEMS && pageNo < MAX_PAGES) {
                    const next = findNextPage($, request.url);
                    if (next) {
                        crawlerLog.info(`Enqueueing next page: ${next}`);
                        await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    } else {
                        crawlerLog.info('No next page found, reached end of pagination');
                    }
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= MAX_ITEMS) return;
                try {
                    // Extract job details from Rozee.pk job detail page
                    const title = $('h1').first().text().trim() || $('title').text().split('-')[0]?.trim() || null;
                    
                    // Company name - usually in h2 or a link near the title
                    const company = $('h2 a[href*="/company/"]').text().trim() || 
                                   $('a[href*="/company/"]').first().text().trim() || null;
                    
                    // Location - from breadcrumb or job details
                    let location = null;
                    $('p, div, span').each((_, el) => {
                        const text = $(el).text();
                        if (text.includes(', Pakistan')) {
                            location = text.trim();
                            return false;
                        }
                    });
                    
                    // Job details section
                    let jobType = null;
                    let jobCategory = null;
                    let salary = null;
                    let datePosted = null;
                    let experience = null;
                    
                    // Parse job details table/list
                    $('h4:contains("Job Details")').parent().find('p, div').each((_, el) => {
                        const text = $(el).text().trim();
                        if (text.includes('Job Type:')) jobType = text.replace('Job Type:', '').trim();
                        if (text.includes('Industry:')) jobCategory = text.replace('Industry:', '').trim();
                        if (text.includes('Functional Area:') && !jobCategory) jobCategory = text.replace('Functional Area:', '').trim();
                    });
                    
                    // Look for job type and category in structured data
                    if (!jobType) {
                        const typeMatch = $('body').text().match(/Job Type:\s*([^\n]+)/i);
                        if (typeMatch) jobType = typeMatch[1].trim();
                    }
                    
                    if (!jobCategory) {
                        const catMatch = $('body').text().match(/Industry:\s*([^\n]+)/i);
                        if (catMatch) jobCategory = catMatch[1].trim();
                    }
                    
                    // Salary - look for PKR or $ amounts
                    const salaryMatch = $('body').text().match(/(?:PKR|Rs\.?|\$)\s*[\d,]+\s*(?:-|to)\s*(?:PKR|Rs\.?|\$)?\s*[\d,]+/i);
                    if (salaryMatch) salary = salaryMatch[0].trim();
                    
                    // Date posted - look for "Posted" text
                    const dateMatch = $('body').text().match(/Posted\s+(.+?)(?:\n|$)/i);
                    if (dateMatch) datePosted = extractDate(dateMatch[1]);
                    
                    // Experience requirement
                    const expMatch = $('body').text().match(/(?:Min\s+)?Experience:\s*([^\n]+)/i);
                    if (expMatch) experience = expMatch[1].trim();
                    
                    // Job description - multiple possible locations
                    let descHtml = null;
                    
                    // Try to find description section
                    const descSection = $('h3:contains("Job Description"), h4:contains("Job Description")').parent();
                    if (descSection.length > 0) {
                        descHtml = descSection.html();
                    } else {
                        // Fallback: get main content area
                        const mainContent = $('div[class*="description"], div[class*="content"], div[id*="description"]').first();
                        if (mainContent.length > 0) {
                            descHtml = mainContent.html();
                        } else {
                            // Last resort: get large text blocks
                            $('div, section').each((_, el) => {
                                const html = $(el).html();
                                if (html && html.length > 200 && !descHtml) {
                                    descHtml = html;
                                }
                            });
                        }
                    }
                    
                    const descText = cleanText(descHtml);
                    
                    const item = {
                        title,
                        company,
                        location,
                        date_posted: datePosted,
                        job_type: jobType,
                        job_category: jobCategory,
                        salary,
                        experience,
                        description_html: descHtml,
                        description_text: descText,
                        job_url: request.url
                    };
                    
                    // Only save if we have minimum required data
                    if (title || company) {
                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job ${saved}: ${title} at ${company}`);
                    } else {
                        crawlerLog.warning(`Skipped job with insufficient data: ${request.url}`);
                    }
                } catch (err) { 
                    crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`, { stack: err.stack }); 
                }
            }
        }
    });

    await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
    log.info(`Finished scraping. Total jobs saved: ${saved}`);
    
    if (failedUrls.length > 0) {
        log.warning(`Failed to scrape ${failedUrls.length} URLs`, { failedUrls: failedUrls.slice(0, 10) });
    }
    
    await Actor.exit();
}

main().catch(err => { 
    console.error('Actor failed with error:', err); 
    process.exit(1); 
});
