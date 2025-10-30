/**
 * src/main.js
 * Fully working Rozee.pk job scraper (API + detail pages, no browser).
 * Stack: Apify SDK, gotScraping, linkedom.
 * Features:
 *  - Direct JSON API scraping (bypasses Cloudflare).
 *  - Auto-fetch full job descriptions from each detail page.
 *  - Supports proxies (await proxyConf.newUrl()).
 *  - Rate limiting and pagination.
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { parseHTML } from 'linkedom';
import { Dataset, sleep } from 'crawlee';

await Actor.init();

async function main() {
  const input = (await Actor.getInput()) || {};
  const {
    keyword = 'developer',
    max_pages = 5,
    results_wanted = 50,
    proxyConfiguration,
    minDelayMs = 1000,
    maxDelayMs = 2000,
  } = input;

  const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
  const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  const API_URL = 'https://www.rozee.pk/job/search';
  let saved = 0;

  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  // Helper: fetch job detail description via linkedom
  async function fetchJobDescription(url) {
    try {
      const res = await gotScraping({
        url,
        http2: true,
        throwHttpErrors: false,
        proxyUrl,
        headers: {
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.statusCode >= 400) {
        log.debug(`Detail fetch failed ${res.statusCode} for ${url}`);
        return null;
      }

      const { document } = parseHTML(res.body || '');
      // Try multiple patterns for job description content
      const sel = [
        'div.job-description',
        'section.job-description',
        'div[class*="description"]',
        'section[class*="description"]',
        'article',
        '#job-detail',
      ];

      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) {
          const text = el.textContent.trim().replace(/\s+/g, ' ');
          if (text.length > 30) return text.slice(0, 4000);
        }
      }

      // fallback: <meta name="description">
      const meta = document.querySelector('meta[name="description"]')?.content;
      if (meta) return meta.trim();

      return null;
    } catch (e) {
      log.debug(`Error fetching detail ${url}: ${e.message}`);
      return null;
    }
  }

  for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
    const body = {
      page,
      q: keyword,
      limit: 20,
    };

    try {
      const res = await gotScraping({
        url: API_URL,
        method: 'POST',
        json: body,
        proxyUrl,
        http2: true,
        throwHttpErrors: false,
        headers: {
          'content-type': 'application/json',
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.statusCode >= 400) {
        log.warning(`Blocked or failed: HTTP ${res.statusCode} on page ${page}`);
        await sleep(3000);
        continue;
      }

      let json;
      try {
        json = typeof res.body === 'object' ? res.body : JSON.parse(res.body);
      } catch {
        const match = res.body.match(/{[\s\S]+}/);
        if (match) json = JSON.parse(match[0]);
      }

      const jobs = json?.data || json?.results || json?.jobs || [];
      if (!Array.isArray(jobs) || jobs.length === 0) {
        log.info(`No jobs found on page ${page}`);
        continue;
      }

      log.info(`Page ${page}: Found ${jobs.length} jobs`);

      for (const job of jobs) {
        if (saved >= results_wanted) break;

        const jobUrl = job.job_url || `https://www.rozee.pk/${job.slug || ''}`;
        const description = await fetchJobDescription(jobUrl);

        const item = {
          id: job.job_id || job.id,
          title: job.job_title || job.title,
          company: job.company_name || job.company || 'Unknown',
          location: job.location || job.city || 'Pakistan',
          datePosted: job.posted_date || job.date_posted,
          url: jobUrl,
          salary: job.salary || 'Not specified',
          experience: job.experience || job.exp_required || '',
          category: job.category || job.industry || '',
          description: description || 'No description found',
          scrapedAt: new Date().toISOString(),
        };

        await Dataset.pushData(item);
        saved++;
        log.info(`✅ [${saved}] ${item.title} @ ${item.company}`);
        await sleep(jitter(minDelayMs, maxDelayMs));
      }

      await sleep(jitter(minDelayMs, maxDelayMs));
    } catch (err) {
      log.error(`Error page ${page}: ${err.message}`);
    }
  }

  log.info(`🎯 Done. Total saved: ${saved}`);
}

try {
  await main();
} catch (err) {
  log.exception(err, 'Fatal error');
} finally {
  await Actor.exit();
}
