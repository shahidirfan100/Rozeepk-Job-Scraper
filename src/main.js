/**
 * src/main.js
 * Rozee.pk Job Scraper — final version using tough-cookie to persist cookies
 * - tough-cookie cookie jars per session to avoid Cloudflare 403s
 * - rotating residential proxy (await proxyConf.newUrl())
 * - headerGeneratorOptions for TLS/fingerprint emulation
 * - JSON _next/data/<buildId> path + fallback to __NEXT_DATA__ in HTML
 * - fetch job detail pages for full description
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import { parseHTML } from 'linkedom';
import { Dataset, sleep } from 'crawlee';

await Actor.init();

async function main() {
  const input = (await Actor.getInput()) || {};
  const {
    keyword = 'developer',
    max_pages = 5,
    results_wanted = 50,
    proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    minDelayMs = 900,
    maxDelayMs = 1700,
  } = input;

  const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  const browserHeaders = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua':
      '"Chromium";v="127", "Not.A/Brand";v="24", "Google Chrome";v="127"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
  };

  log.info('🚀 Starting Rozee.pk scraper', { keyword, max_pages, results_wanted });

  // Create a fresh cookie jar for each logical session (homepage → json → details).
  // We re-create per 'session' and reuse that jar for subsequent requests to appear like one browser.
  const makeJar = () => new CookieJar();

  // -------------------- detect buildId (using cookie jar per attempt) --------------------
  async function detectBuildId() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const jar = makeJar();
      try {
        const proxyUrl = await proxyConf.newUrl();
        const res = await gotScraping({
          url: 'https://www.rozee.pk/',
          proxyUrl,
          http2: true,
          headers: browserHeaders,
          cookieJar: jar,
          headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'] },
          throwHttpErrors: false,
          timeout: { request: 15000 },
        });

        if (res.statusCode === 200 && res.body) {
          // Pattern 1: "buildId":"..."
          let m = res.body.match(/"buildId":"([^"]+)"/);
          if (m) {
            log.info(`detectBuildId: found via pattern1 on attempt ${attempt}`);
            return { buildId: m[1], jar, proxyUrl };
          }

          // Pattern 2: <script id="__NEXT_DATA__">...</script>
          const sm = res.body.match(
            /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
          );
          if (sm) {
            try {
              const parsed = JSON.parse(sm[1]);
              if (parsed?.buildId) {
                log.info(`detectBuildId: found via __NEXT_DATA__ on attempt ${attempt}`);
                return { buildId: parsed.buildId, jar, proxyUrl };
              }
            } catch (e) {
              log.debug('NEXT_DATA parse error: ' + e.message);
            }
          }
        } else {
          log.warning(`Homepage HTTP ${res.statusCode} on attempt ${attempt}`);
        }
      } catch (err) {
        log.warning(`detectBuildId attempt ${attempt} error: ${err.message}`);
      }
      await sleep(2000 + Math.random() * 1000);
    }
    return null;
  }

  const buildInfo = await detectBuildId();
  let buildId = buildInfo?.buildId || null;
  if (buildId) log.info(`✅ Found buildId: ${buildId}`);
  else log.warning('⚠️ Could not extract buildId — will use HTML fallback if necessary.');

  // -------------------- fetch job description using same-cookie approach --------------------
  async function fetchJobDescription(jobUrl, parentJar = null) {
    // If parentJar provided, reuse it; otherwise create a new one per detail fetch
    const jar = parentJar || makeJar();
    try {
      const proxyUrl = await proxyConf.newUrl();
      const res = await gotScraping({
        url: jobUrl,
        proxyUrl,
        http2: true,
        headers: browserHeaders,
        cookieJar: jar,
        headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'] },
        throwHttpErrors: false,
        timeout: { request: 25000 },
      });
      if (res.statusCode >= 400) {
        log.debug(`Detail fetch ${res.statusCode} for ${jobUrl}`);
        return null;
      }
      const { document } = parseHTML(res.body || '');
      const selectors = [
        'div.job-description',
        'section.job-description',
        'div[class*="description"]',
        'section[class*="description"]',
        'article',
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el) {
          const txt = el.textContent.trim().replace(/\s+/g, ' ');
          if (txt.length > 30) return txt.slice(0, 4000);
        }
      }
      const meta = document.querySelector('meta[name="description"]')?.content?.trim();
      return meta || null;
    } catch (err) {
      log.debug(`fetchJobDescription error for ${jobUrl}: ${err.message}`);
      return null;
    }
  }

  // -------------------- process single job --------------------
  async function processJob(job, jar = null) {
    const jobUrl = job.jobUrl || job.url || (job.slug ? `https://www.rozee.pk/job/${job.slug}` : null);
    const description = jobUrl ? await fetchJobDescription(jobUrl, jar) : null;

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
    log.info(`💼 Saved: ${item.title} @ ${item.company}`);
  }

  // -------------------- MAIN: JSON path using buildId (reusing jar from detection if present) --------------------
  let saved = 0;

  if (buildId) {
    // If we got a jar together with buildId (from detectBuildId), reuse that jar for the first JSON request
    let initialJar = buildInfo?.jar || makeJar();

    for (let page = 1; page <= max_pages && saved < results_wanted; page++) {
      const jsonUrl = `https://www.rozee.pk/_next/data/${buildId}/job/jsearch/q/${encodeURIComponent(keyword)}.json?page=${page}`;
      log.info(`Fetching JSON page ${page}: ${jsonUrl}`);
      try {
        // Use a jar per page but seed it with initialJar cookies for first page to maintain continuity
        const pageJar = page === 1 ? initialJar : makeJar();
        const res = await gotScraping({
          url: jsonUrl,
          proxyUrl: await proxyConf.newUrl(),
          http2: true,
          headers: browserHeaders,
          cookieJar: pageJar,
          headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'] },
          throwHttpErrors: false,
          timeout: { request: 20000 },
        });

        if (res.statusCode === 403) {
          log.warning('403 on JSON endpoint, switching to fallback HTML');
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
          log.info(`No jobs found on JSON page ${page}`);
          continue;
        }

        for (const job of jobs) {
          if (saved >= results_wanted) break;
          // reuse the same jar for detail fetch to keep cookies consistent
          await processJob(job, pageJar);
          saved++;
          await sleep(jitter(minDelayMs, maxDelayMs));
        }
      } catch (err) {
        log.error(`Error fetching JSON page ${page}: ${err.message}`);
      }
    }
  }

  // -------------------- FALLBACK: parse __NEXT_DATA__ from HTML (use jar from detect or fresh) --------------------
  if (saved === 0) {
    log.info('Fallback: parsing __NEXT_DATA__ JSON from HTML');
    const jar = buildInfo?.jar || makeJar();
    try {
      const listUrl = `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(keyword)}`;
      const res = await gotScraping({
        url: listUrl,
        proxyUrl: await proxyConf.newUrl(),
        http2: true,
        headers: browserHeaders,
        cookieJar: jar,
        headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'] },
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
        const jobs = parsed?.props?.pageProps?.jobs || parsed?.props?.pageProps?.results || [];
        log.info(`Parsed ${Array.isArray(jobs) ? jobs.length : 0} jobs from __NEXT_DATA__`);

        if (Array.isArray(jobs)) {
          for (const job of jobs.slice(0, results_wanted - saved)) {
            await processJob(job, jar);
            saved++;
            await sleep(jitter(minDelayMs, maxDelayMs));
          }
        }
      } else {
        log.warning('No __NEXT_DATA__ found in fallback HTML.');
      }
    } catch (err) {
      log.error(`Fallback parsing error: ${err.message}`);
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
