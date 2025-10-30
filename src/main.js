/**
 * Rozee.pk job scraper (Next.js JSON API + detail pages)
 * - Auto-detects buildId from Next.js __NEXT_DATA__
 * - Fetches job listings via JSON endpoint
 * - Fetches each job's detail page for full description
 * - Falls back to static HTML scraping if JSON fails
 * - Works with or without proxies
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
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  // ===================================================================
  // 1️⃣  Discover buildId from Next.js __NEXT_DATA__
  // ===================================================================
  let buildId;

  async function detectBuildId() {
    try {
      const localProxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;
      const res = await gotScraping({
        url: 'https://www.rozee.pk/',
        proxyUrl: localProxyUrl,
        http2: true,
        throwHttpErrors: false,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.statusCode >= 400) {
        log.warning(`Homepage returned HTTP ${res.statusCode}`);
        return null;
      }

      const body = res.body || '';

      // Classic pattern
      let match = body.match(/"buildId":"([^"]+)"/);
      if (match) return match[1];

      // <script id="__NEXT_DATA__">
      const scriptMatch = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (scriptMatch) {
        try {
          const parsed = JSON.parse(scriptMatch[1]);
          if (parsed.buildId) return parsed.buildId;
        } catch (err) {
          log.debug('NEXT_DATA parse failed: ' + err.message);
        }
      }

      // window.__NEXT_DATA__
      match = body.match(/window\.__NEXT_DATA__\s*=\s*({[\s\S]*?})<\/script>/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed.buildId) return parsed.buildId;
        } catch {}
      }

      return null;
    } catch (e) {
      log.warning(`detectBuildId() failed: ${e.message}`);
      return null;
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    buildId = await detectBuildId();
    if (buildId) break;
    log.warning(`Attempt ${attempt} to get buildId failed, retrying...`);
    await sleep(2000);
  }

  if (!buildId) {
    log.warning('⚠️ Could not extract buildId — falling back to static HTML scraping');
  } else {
    log.info(`✅ Found buildId: ${buildId}`);
  }

  // ===================================================================
  // 2️⃣ Helper: Fetch job description text from detail pages
  // ===================================================================
  async function fetchJobDescription(url) {
    try {
      const res = await gotScraping({
        url,
        http2: true,
        throwHttpErrors: false,
        proxyUrl,
        headers: {
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
            AppleWebKit/537.36 (KHTML, like Gecko)
            Chrome/120.0 Safari/537.36`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.statusCode >= 400) return null;
      const { document } = parseHTML(res.body || '');
      const el =
        document.querySelector('div.job-description, section.job-description, div[class*="description"], section[class*="description"], article');
      const text = el?.textContent?.trim().replace(/\s+/g, ' ') || '';
      return text.slice(0, 4000) || null;
    } catch (e) {
      log.debug(`Detail fetch failed (${url}): ${e.message}`);
      return null;
    }
  }

  // ===================================================================
  // 3️⃣ Fetch jobs (JSON or fallback)
  // ===================================================================
  let saved = 0;

  if (buildId) {
    // ---------- JSON API path ----------
    for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
      const jsonUrl = `https://www.rozee.pk/_next/data/${buildId}/job/jsearch/q/${encodeURIComponent(
        keyword
      )}.json?page=${page}`;
      log.info(`Fetching page ${page}: ${jsonUrl}`);

      try {
        const res = await gotScraping({
          url: jsonUrl,
          proxyUrl,
          http2: true,
          throwHttpErrors: false,
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
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
      } catch (e) {
        log.error(`Error on page ${page}: ${e.message}`);
      }
    }
  }

  // ===================================================================
  // 4️⃣ Fallback: Basic HTML scraping if no buildId found
  // ===================================================================
  if (!buildId && saved === 0) {
    log.info('Using HTML fallback scraping...');

    const listUrl = `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(keyword)}`;
    try {
      const res = await gotScraping({
        url: listUrl,
        proxyUrl,
        http2: true,
        throwHttpErrors: false,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const { document } = parseHTML(res.body);
      const links = [...document.querySelectorAll('#jobs h3 a')].map((a) => a.href).filter(Boolean);

      log.info(`Found ${links.length} fallback links`);

      for (const link of links.slice(0, results_wanted)) {
        const desc = await fetchJobDescription(link);
        const item = {
          title: document.querySelector('title')?.textContent || 'Unknown title',
          company: 'Unknown',
          location: 'Pakistan',
          url: link,
          description: desc || 'No description found',
          scrapedAt: new Date().toISOString(),
        };
        await Dataset.pushData(item);
        saved++;
        log.info(`💼 [${saved}] ${item.title}`);
        await sleep(jitter(minDelayMs, maxDelayMs));
      }
    } catch (err) {
      log.error('Fallback failed: ' + err.message);
    }
  }

  // ===================================================================
  // 5️⃣ Done
  // ===================================================================
  log.info(`🎯 Done. Total jobs saved: ${saved}`);
}

try {
  await main();
} catch (err) {
  log.exception(err, 'Fatal error');
} finally {
  await Actor.exit();
}
