// Rozee.pk jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
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
    } = input;

    const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;
    
    log.info('Actor configuration', { MAX_ITEMS, MAX_PAGES, collectDetails, keyword, location, datePosted });

    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try { return new URL(href, base).href; } catch { return null; }
    };

    const cleanText = (html) => {
        if (!html) return '';
        const $ = cheerioLoad(html);
        $('script, style, noscript, iframe').remove();
        return $.root().text().replace(/\s+/g, ' ').trim();
    };

    // Parse date string and check if it's within the filter
    const isWithinDateFilter = (dateStr, filter) => {
        if (!dateStr || filter === 'all') return true;
        
        const now = new Date();
        const cutoffHours = filter === '24hours' ? 24 : filter === '7days' ? 168 : filter === '30days' ? 720 : 0;
        if (!cutoffHours) return true;
        
        // Check for "X hours ago"
        const hoursMatch = dateStr.match(/(\d+)\s*hours?\s*ago/i);
        if (hoursMatch) {
            const hours = parseInt(hoursMatch[1]);
            return hours <= cutoffHours;
        }
        
        // Check for "X days ago"
        const daysMatch = dateStr.match(/(\d+)\s*days?\s*ago/i);
        if (daysMatch) {
            const days = parseInt(daysMatch[1]);
            return (days * 24) <= cutoffHours;
        }
        
        // Check for "Yesterday" or "Today"
        if (dateStr.toLowerCase().includes('today')) return true;
        if (dateStr.toLowerCase().includes('yesterday')) return cutoffHours >= 24;
        
        // Parse full date format "Oct 29, 2025"
        const dateMatch = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})/);
        if (dateMatch) {
            const jobDate = new Date(dateMatch[0]);
            const diffMs = now - jobDate;
            const diffHours = diffMs / (1000 * 60 * 60);
            return diffHours <= cutoffHours;
        }
        
        return true;
    };

    // Build search URL based on keyword
    const buildStartUrl = () => {
        if (keyword && keyword.trim()) {
            const cleanKeyword = keyword.trim().toLowerCase().replace(/\s+/g, '-');
            return 'https://www.rozee.pk/job/jsearch/q/' + encodeURIComponent(cleanKeyword);
        }
        return 'https://www.rozee.pk/job/jsearch/q/all';
    };
    
    // Prepare start URLs
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
    
    // Multiple methods to find job links with fallbacks
    function findJobLinks($, base) {
        const links = new Set();
        
        // Method 1: Links with pattern /company-title-location-jobs-ID
        $('a[href*="-jobs-"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && /\/[^\/]+-jobs-\d+/.test(href)) {
                const abs = toAbs(href, base);
                if (abs) links.add(abs.split('?')[0]);
            }
        });
        
        // Method 2: Links within job card containers
        $('.job, .job-card, [class*="job"]').find('a[href*="/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('-jobs-')) {
                const abs = toAbs(href, base);
                if (abs) links.add(abs.split('?')[0]);
            }
        });
        
        // Method 3: Search for job detail pattern in all links
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.match(/jobs-\d{6,}/)) {
                const abs = toAbs(href, base);
                if (abs && abs.includes('rozee.pk')) links.add(abs.split('?')[0]);
            }
        });
        
        return [...links].filter(link => !link.includes('/company/') && !link.includes('/jsearch/'));
    }

    // Multiple methods to find pagination with fallbacks
    function findNextPage($, base) {
        // Method 1: "Next" button
        let nextLink = $('a:contains("Next"), a.next, [class*="next"]').attr('href');
        if (nextLink) return toAbs(nextLink, base);
        
        // Method 2: Numbered pagination
        const currentPage = $('.pagination .active, .current, [class*="active"]').text().trim();
        if (currentPage && !isNaN(currentPage)) {
            const nextPage = parseInt(currentPage) + 1;
            const nextPageLink = $('.pagination a:contains("' + nextPage + '")').attr('href');
            if (nextPageLink) return toAbs(nextPageLink, base);
        }
        
        return null;
    }
    
    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 5,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxUsageCount: 10,
            },
        },
        maxConcurrency: 3,
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 90,
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (label === 'LIST') {
                crawlerLog.info('Processing listing page ' + pageNo + ': ' + request.url);
                
                const jobLinks = findJobLinks($, request.url);
                crawlerLog.info('Found ' + jobLinks.length + ' job links on page ' + pageNo);
                
                if (jobLinks.length === 0) {
                    crawlerLog.warning('No job links found on page ' + pageNo + '. Page might be blocked or structure changed.');
                }
                
                if (collectDetails && jobLinks.length > 0) {
                    const remaining = MAX_ITEMS - saved;
                    const toEnqueue = jobLinks.slice(0, Math.max(0, remaining));
                    if (toEnqueue.length > 0) {
                        crawlerLog.info('Enqueueing ' + toEnqueue.length + ' job detail pages');
                        await enqueueLinks({ 
                            urls: toEnqueue.map(url => ({ url, userData: { label: 'DETAIL' } }))
                        });
                    }
                }
                
                if (saved < MAX_ITEMS && pageNo < MAX_PAGES) {
                    const next = findNextPage($, request.url);
                    if (next) {
                        crawlerLog.info('Enqueueing next page ' + (pageNo + 1) + ': ' + next);
                        await enqueueLinks({ 
                            urls: [{ url: next, userData: { label: 'LIST', pageNo: pageNo + 1 } }]
                        });
                    } else {
                        crawlerLog.info('No next page found, reached end of pagination');
                    }
                } else {
                    crawlerLog.info('Stopping pagination: saved=' + saved + ', MAX_ITEMS=' + MAX_ITEMS + ', pageNo=' + pageNo + ', MAX_PAGES=' + MAX_PAGES);
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= MAX_ITEMS) {
                    crawlerLog.info('Skipping job detail: already saved ' + saved + '/' + MAX_ITEMS + ' jobs');
                    return;
                }
                
                try {
                    crawlerLog.info('Processing job detail: ' + request.url);
                    
                    // Extract job title with multiple fallbacks
                    let title = $('h1').first().text().trim();
                    if (!title) title = $('title').text().split('-')[0]?.split('|')[0]?.trim();
                    if (!title) title = $('[class*="job-title"], [class*="title"]').first().text().trim();
                    
                    // Extract company name with multiple fallbacks
                    let company = $('h2 a[href*="/company/"]').text().trim();
                    if (!company) company = $('a[href*="/company/"]').first().text().trim();
                    if (!company) company = $('[class*="company"]').first().text().trim();
                    
                    // Extract location with multiple fallbacks
                    let jobLocation = null;
                    $('p, div, span, li').each((_, el) => {
                        const text = $(el).text().trim();
                        if (text.includes('Pakistan') && text.length < 100) {
                            jobLocation = text;
                            return false;
                        }
                    });
                    if (!jobLocation) {
                        jobLocation = $('[class*="location"], [class*="city"]').first().text().trim();
                    }
                    
                    // Extract date posted with multiple fallbacks
                    let datePostedText = null;
                    $('p, div, span').each((_, el) => {
                        const text = $(el).text().trim();
                        if (text.toLowerCase().includes('posted') || text.includes('ago') || 
                            /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/.test(text)) {
                            datePostedText = text;
                            return false;
                        }
                    });
                    
                    // Apply date filter
                    if (!isWithinDateFilter(datePostedText, datePosted)) {
                        crawlerLog.info('Skipping job: outside date filter (' + datePosted + '). Posted: ' + datePostedText);
                        return;
                    }
                    
                    // Extract job type
                    let jobType = null;
                    const jobTypeMatch = $.html().match(/Job Type[:\s]*([^<\n]+)/i);
                    if (jobTypeMatch) jobType = jobTypeMatch[1].trim();
                    
                    // Extract salary
                    let salary = null;
                    const salaryMatch = $.html().match(/PKR?\.?\s*([\d,]+-?[\d,]*)\s*[\/]?\s*(Month|Per Month|Yearly)?/i);
                    if (salaryMatch) salary = salaryMatch[0].trim();
                    if (!salary) {
                        $('p, div, span').each((_, el) => {
                            const text = $(el).text().trim();
                            if (text.match(/\d+K\s*-\s*\d+K/) || text.match(/PKR/i)) {
                                salary = text;
                                return false;
                            }
                        });
                    }
                    
                    // Extract experience
                    let experience = null;
                    const expMatch = $.html().match(/(\d+)\s*(Years?|Year)/i);
                    if (expMatch) experience = expMatch[0].trim();
                    
                    // Extract job description
                    let description = $('h4:contains("Job Description")').parent().text().trim();
                    if (!description || description.length < 50) {
                        description = $('[class*="description"], [class*="detail"]').first().text().trim();
                    }
                    if (!description || description.length < 50) {
                        description = cleanText($('body').html()).slice(0, 2000);
                    }
                    
                    // Extract skills
                    const skills = [];
                    $('h4:contains("Skills")').parent().find('a, span').each((_, el) => {
                        const skill = $(el).text().trim();
                        if (skill && skill.length > 1 && skill.length < 50) {
                            skills.push(skill);
                        }
                    });
                    
                    // Extract job category/functional area
                    let category = null;
                    const catMatch = $.html().match(/Functional Area[:\s]*([^<\n]+)/i);
                    if (catMatch) category = catMatch[1].trim();
                    
                    // Create job object
                    const job = {
                        url: request.url,
                        title: title || 'Unknown Title',
                        company: company || 'Unknown Company',
                        location: jobLocation || 'Pakistan',
                        salary: salary || 'Not specified',
                        experience: experience || 'Not specified',
                        jobType: jobType || 'Not specified',
                        category: category || 'Not specified',
                        description: description || 'No description available',
                        skills: skills.length > 0 ? skills.join(', ') : 'Not specified',
                        datePosted: datePostedText || 'Unknown',
                        scrapedAt: new Date().toISOString(),
                    };
                    
                    // Validate minimum required fields
                    if (!title || !company) {
                        crawlerLog.warning('Skipping job: missing critical data (title or company)', { url: request.url });
                        failedUrls.push({ url: request.url, reason: 'Missing critical fields' });
                        return;
                    }
                    
                    // Save to dataset
                    await Dataset.pushData(job);
                    saved++;
                    crawlerLog.info('Saved job ' + saved + '/' + MAX_ITEMS + ': ' + title + ' at ' + company);
                    
                } catch (err) {
                    crawlerLog.error('Error extracting job details from ' + request.url + ':', err);
                    failedUrls.push({ url: request.url, reason: err.message });
                }
            }
        },
        async failedRequestHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error('Request failed: ' + request.url, { error: error.message });
            failedUrls.push({ url: request.url, reason: error.message });
        },
    });

    await crawler.run(initial.map(url => ({ url, userData: { label: 'LIST', pageNo: 1 } })));

    log.info('Scraping completed', {
        totalJobsSaved: saved,
        failedUrls: failedUrls.length,
        maxItemsTarget: MAX_ITEMS,
    });

    if (failedUrls.length > 0) {
        log.warning('Failed to scrape ' + failedUrls.length + ' URLs', { failedUrls: failedUrls.slice(0, 10) });
    }
}

try {
    await main();
} catch (err) {
    log.error('Fatal error in main:', err);
    throw err;
} finally {
    await Actor.exit();
}
