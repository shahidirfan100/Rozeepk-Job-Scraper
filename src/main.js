/**
 * Rozee.pk job scraper (Next.js JSON API + detail pages)
 * No browser automation, HTTP-only.
 * Automatically detects buildId and scrapes job data.
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
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  // ---------- 1️⃣ Discover buildId ----------
  let buildId;
  try {
    const res = await gotScraping({
      url: 'https://www.rozee.pk/',
      proxyUrl,
      http2: true,
      throwHttpErrors: false,
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
    });
    const match = res.body.match(/"buildId":"([^"]+)"/);
    buildId = match ? match[1] : null;
  } catch (e) {
    log.warning(`Failed to detect buildId: ${e.message}`);
  }

  if (!buildId) throw new Error('❌ Could not extract Next.js buildId — cannot fetch job data');

  log.info(`✅ Found buildId: ${buildId}`);

  // ---------- 2️⃣ Prepare for scraping ----------
  let saved = 0;

  async function fetchJobDescription(url) {
    try {
      const resp = await gotScraping({
        url,
        http2: true,
        throwHttpErrors: false,
        proxyUrl,
        headers: {
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (resp.statusCode >= 400) return null;
      const { document } = parseHTML(resp.body || '');
      const el = document.querySelector('div.job-description, section.job-description, div[class*="description"], section[class*="description"], article');
      const text = el?.textContent?.trim().replace(/\s+/g, ' ') || '';
      return text.slice(0, 4000) || null;
    } catch (e) {
      log.debug(`Description fetch failed: ${e.message}`);
      return null;
    }
  }

  // ---------- 3️⃣ Loop through pagination ----------
  for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
    const url = `https://www.rozee.pk/_next/data/${buildId}/job/jsearch/q/${encodeURIComponent(keyword)}.json?page=${page}`;
    log.info(`Fetching page ${page}: ${url}`);

    try {
      const res = await gotScraping({
        url,
        proxyUrl,
        http2: true,
        throwHttpErrors: false,
        headers: {
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.statusCode >= 400) {
        log.warning(`HTTP ${res.statusCode} on page ${page}`);
        continue;
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
        log.info(`No jobs found on page ${page}`);
        continue;
      }

      log.info(`✅ Page ${page}: ${jobs.length} jobs found`);

      for (const job of jobs) {
        if (saved >= results_wanted) break;
        const jobUrl = job.jobUrl || job.url || `https://www.rozee.pk/job/${job.slug || ''}`;
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

      await sleep(jitter(minDelayMs, maxDelayMs));
    } catch (e) {
      log.error(`Error on page ${page}: ${e.message}`);
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
