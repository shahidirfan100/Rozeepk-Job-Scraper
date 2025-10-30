/**
 * Rozee.pk Job Scraper (HTTP-only)
 * - Cloudflare-resilient: strong browser headers + proxy session rotation
 * - Auto-detect Next.js buildId (with retries)
 * - JSON route via /_next/data/<buildId>/job/jsearch/q/<kw>.json?page=#
 * - Fallback: parse __NEXT_DATA__ JSON embedded in HTML
 * - Fetch full job descriptions from detail pages
 * - No Playwright/Puppeteer
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
    proxyConfiguration = {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
    minDelayMs = 900,
    maxDelayMs = 1800,
  } = input;

  const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  // Use a realistic browser header set across ALL requests
  const browserHeaders = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'upgrade-insecure-requests': '1',
  };

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  // -------------------- buildId detection --------------------
  async function detectBuildId() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await gotScraping({
          url: 'https://www.rozee.pk/',
          proxyUrl: await proxyConf.newUrl(),
          http2: true,
          headers: browserHeaders,
          throwHttpErrors: false,
          timeout: { request: 15000 },
        });

        if (res.statusCode === 200 && res.body) {
          // Pattern 1: "buildId":"..."
          let m = res.body.match(/"buildId":"([^"]+)"/);
          if (m) return m[1];

          // Pattern 2: <script id="__NEXT_DATA__">{...}
          const sm = res.body.match(
            /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
          );
          if (sm) {
            try {
              const parsed = JSON.parse(sm[1]);
              if (parsed?.buildId) return parsed.buildId;
            } catch (e) {
              log.debug('NEXT_DATA parse fail: ' + e.message);
            }
          }
        } else {
          log.warning(`Homepage HTTP ${res.statusCode} on attempt ${attempt}`);
        }
      } catch (e) {
        log.warning(`Attempt ${attempt} failed: ${e.message}`);
      }
      await sleep(2000);
    }
    return null;
  }

  let buildId = await detectBuildId();
  if (buildId) log.info(`✅ Found buildId: ${buildId}`);
  else log.warning('⚠️ Could not extract buildId — will use HTML fallback if needed.');

  // -------------------- helpers --------------------
  async function fetchJobDescription(url) {
    try {
      const res = await gotScraping({
        url,
        proxyUrl: await proxyConf.newUrl(),
        http2: true,
        headers: browserHeaders,
        throwHttpErrors: false,
        timeout: { request: 25000 },
      });
      if (res.statusCode >= 400) return null;

      const { document } = parseHTML(res.body || '');
      const candidates = [
        'div.job-description',
        'section.job-description',
        'div[class*="description"]',
        'section[class*="description"]',
        'article',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) {
          const txt = el.textContent.trim().replace(/\s+/g, ' ');
          if (txt.length > 30) return txt.slice(0, 4000);
        }
      }
      const meta = document.querySelector('meta[name="description"]')?.content?.trim();
      return meta || null;
    } catch (e) {
      log.debug(`Detail fetch error (${url}): ${e.message}`);
      return null;
    }
  }

  async function processJob(job, delays = true) {
    const jobUrl = job.jobUrl || job.url || (job.slug ? `https://www.rozee.pk/job/${job.slug}` : '');
    const description = jobUrl ? await fetchJobDescription(jobUrl) : null;

    const item = {
      title: job.title || job.jobTitle || 'Unknown',
      company: job.company || job.companyName || 'Unknown',
      location: job.location || job.city || 'Pakistan',
      datePosted: job.postedOn || job.postedDate || null,
      url: jobUrl || null,
      salary: job.salary || 'Not specified',
      experience: job.experience || job.expRequired || '',
      category: job.category || job.industry || '',
      description: description || 'No description found',
      scrapedAt: new Date().toISOString(),
    };

    await Dataset.pushData(item);
    log.info(`💼 ${item.title} @ ${item.company}`);
    if (delays) await sleep(jitter(minDelayMs, maxDelayMs));
  }

  // -------------------- main paths --------------------
  let saved = 0;

  // 1) JSON API path (if buildId found)
  if (buildId) {
    for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
      const jsonUrl = `https://www.rozee.pk/_next/data/${buildId}/job/jsearch/q/${encodeURIComponent(
        keyword
      )}.json?page=${page}`;
      log.info(`Fetching JSON page ${page}: ${jsonUrl}`);

      try {
        const res = await gotScraping({
          url: jsonUrl,
          proxyUrl: await proxyConf.newUrl(),
          http2: true,
          headers: browserHeaders,
          throwHttpErrors: false,
          timeout: { request: 20000 },
        });

        if (res.statusCode === 403) {
          log.warning('403 on JSON endpoint – switching to fallback');
          break;
        }
        if (res.statusCode >= 400) {
          log.warning(`HTTP ${res.statusCode} on JSON page ${page}`);
          continue;
        }

        let json;
        try {
          json = JSON.parse(res.body);
        } catch (e) {
          log.error(`JSON parse failed on page ${page}: ${e.message}`);
          continue;
        }

        const jobs = json?.pageProps?.jobs || json?.pageProps?.results || [];
        if (!Array.isArray(jobs) || jobs.length === 0) {
          log.info(`No jobs on JSON page ${page}`);
          continue;
        }

        for (const job of jobs) {
          if (saved >= results_wanted) break;
          await processJob(job);
          saved++;
        }
      } catch (e) {
        log.error(`Error fetching JSON page ${page}: ${e.message}`);
      }
    }
  }

  // 2) Fallback: parse __NEXT_DATA__ JSON from the HTML page
  if (saved === 0) {
    log.info('Fallback: parsing __NEXT_DATA__ JSON from HTML');
    try {
      const listUrl = `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(keyword)}`;
      const res = await gotScraping({
        url: listUrl,
        proxyUrl: await proxyConf.newUrl(),
        http2: true,
        headers: browserHeaders,
        throwHttpErrors: false,
        timeout: { request: 20000 },
      });

      if (res.statusCode >= 400) {
        log.warning(`Fallback page HTTP ${res.statusCode}`);
      }

      const body = res.body || '';
      const m = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (m) {
        let parsed;
        try {
          parsed = JSON.parse(m[1]);
        } catch (e) {
          log.error(`__NEXT_DATA__ JSON parse failed: ${e.message}`);
        }
        const jobs =
          parsed?.props?.pageProps?.jobs || parsed?.props?.pageProps?.results || [];
        log.info(`HTML fallback found ${Array.isArray(jobs) ? jobs.length : 0} jobs`);

        if (Array.isArray(jobs)) {
          for (const job of jobs.slice(0, Math.max(0, results_wanted - saved))) {
            await processJob(job);
            saved++;
          }
        }
      } else {
        log.warning('No __NEXT_DATA__ script found in fallback HTML.');
      }
    } catch (e) {
      log.error(`Fallback error: ${e.message}`);
    }
  }

  log.info(`🎯 Done. Total jobs saved: ${saved}`);
}

try {
  await main();
} catch (err) {
  log.exception(err, 'Fatal error');
} finally {
  await Actor.exit();
}
