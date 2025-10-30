/**
 * Rozee.pk Job Scraper
 * -------------------------------------------
 * - Bypasses Cloudflare via realistic browser headers
 * - Auto-detects Next.js buildId
 * - Scrapes job listings via JSON endpoint
 * - Falls back to parsing __NEXT_DATA__ JSON from HTML
 * - Fetches each job's full description
 * - No Playwright/Puppeteer needed
 */

import { Actor, log } from 'apify';
import { gotScraping, Headers } from 'got-scraping';
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
    minDelayMs = 1000,
    maxDelayMs = 2000,
  } = input;

  const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const proxyUrl = await proxyConf.newUrl();

  const browserHeaders = new Headers({
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
  });

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  // ===================================================================
  // 1️⃣  Discover buildId from Next.js
  // ===================================================================
  async function detectBuildId() {
    for (let i = 0; i < 5; i++) {
      try {
        const proxyUrlLocal = await proxyConf.newUrl();
        const res = await gotScraping({
          url: 'https://www.rozee.pk/',
          proxyUrl: proxyUrlLocal,
          http2: true,
          headers: browserHeaders,
          throwHttpErrors: false,
          timeout: { request: 15000 },
        });

        if (res.statusCode === 200 && res.body) {
          // Try normal pattern
          const match = res.body.match(/"buildId":"([^"]+)"/);
          if (match) return match[1];

          // Try __NEXT_DATA__ script
          const scriptMatch = res.body.match(
            /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
          );
          if (scriptMatch) {
            const parsed = JSON.parse(scriptMatch[1]);
            if (parsed.buildId) return parsed.buildId;
          }
        } else {
          log.warning(`Homepage HTTP ${res.statusCode} on attempt ${i + 1}`);
        }
      } catch (err) {
        log.warning(`Attempt ${i + 1} to get buildId failed: ${err.message}`);
      }
      await sleep(3000);
    }
    return null;
  }

  let buildId = await detectBuildId();
  if (!buildId) log.warning('⚠️ Could not extract buildId — will use fallback parsing.');
  else log.info(`✅ Found buildId: ${buildId}`);

  // ===================================================================
  // 2️⃣ Helper: Fetch job description
  // ===================================================================
  async function fetchJobDescription(url) {
    try {
      const res = await gotScraping({
        url,
        proxyUrl: await proxyConf.newUrl(),
        http2: true,
        throwHttpErrors: false,
        headers: browserHeaders,
      });

      if (res.statusCode >= 400) return null;
      const { document } = parseHTML(res.body || '');
      const el =
        document.querySelector('div.job-description, section.job-description, div[class*="description"], section[class*="description"], article');
      const text = el?.textContent?.trim().replace(/\s+/g, ' ') || '';
      return text.slice(0, 4000) || null;
    } catch (e) {
      log.debug(`Description fetch failed: ${e.message}`);
      return null;
    }
  }

  // ===================================================================
  // 3️⃣ Fetch job listings (JSON or fallback)
  // ===================================================================
  let saved = 0;

  async function processJob(job) {
    const jobUrl =
      job.jobUrl || job.url || `https://www.rozee.pk/job/${job.slug || ''}`;
    const desc = await fetchJobDescription(jobUrl);

    const item = {
      title: job.title || job.jobTitle,
      company: job.company || job.companyName || 'Unknown',
      location: job.location || job.city || 'Pakistan',
      datePosted: job.postedOn || job.postedDate,
      url: jobUrl,
      salary: job.salary || 'Not specified',
      experience: job.experience || job.expRequired || '',
      category: job.category || job.industry || '',
      description: desc || 'No description found',
      scrapedAt: new Date().toISOString(),
    };

    await Dataset.pushData(item);
    saved++;
    log.info(`💼 [${saved}] ${item.title} @ ${item.company}`);
    await sleep(jitter(minDelayMs, maxDelayMs));
  }

  if (buildId) {
    for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
      const jsonUrl = `https://www.rozee.pk/_next/data/${buildId}/job/jsearch/q/${encodeURIComponent(
        keyword,
      )}.json?page=${page}`;
      log.info(`Fetching JSON page ${page}`);

      try {
        const res = await gotScraping({
          url: jsonUrl,
          proxyUrl: await proxyConf.newUrl(),
          http2: true,
          headers: browserHeaders,
          throwHttpErrors: false,
        });

        if (res.statusCode === 403) {
          log.warning('403 on JSON page — switching to fallback parser');
          break;
        }

        let json;
        try {
          json = JSON.parse(res.body);
        } catch (err) {
          log.error(`JSON parse failed for page ${page}: ${err.message}`);
          continue;
        }

        const jobs = json?.pageProps?.jobs || json?.pageProps?.results || [];
        if (!jobs.length) {
          log.info(`No jobs found on JSON page ${page}`);
          continue;
        }

        log.info(`✅ Page ${page}: ${jobs.length} jobs found`);
        for (const job of jobs) {
          if (saved >= results_wanted) break;
          await processJob(job);
        }
      } catch (e) {
        log.error(`Error fetching JSON page ${page}: ${e.message}`);
      }
    }
  }

  // ===================================================================
  // 4️⃣ Fallback: Parse __NEXT_DATA__ JSON directly from HTML
  // ===================================================================
  if (!buildId || saved === 0) {
    log.info('Using HTML fallback (__NEXT_DATA__) parsing...');
    try {
      const listUrl = `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(keyword)}`;
      const res = await gotScraping({
        url: listUrl,
        proxyUrl: await proxyConf.newUrl(),
        http2: true,
        headers: browserHeaders,
        throwHttpErrors: false,
      });

      if (res.statusCode >= 400) {
        log.warning(`Fallback page HTTP ${res.statusCode}`);
      }

      const body = res.body || '';
      const match = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (match) {
        const parsed = JSON.parse(match[1]);
        const jobs =
          parsed?.props?.pageProps?.jobs || parsed?.props?.pageProps?.results || [];
        log.info(`Parsed ${jobs.length} jobs from __NEXT_DATA__ HTML fallback`);

        for (const job of jobs.slice(0, results_wanted)) {
          await processJob(job);
        }
      } else {
        log.warning('❌ No __NEXT_DATA__ JSON found in fallback HTML');
      }
    } catch (err) {
      log.error(`Fallback failed: ${err.message}`);
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
