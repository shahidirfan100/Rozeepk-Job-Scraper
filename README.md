# RozeePk Jobs Scraper

Effortlessly scrape and collect job listings from Rozee.pk, Pakistan's leading job board. This powerful Apify actor automates the extraction of job opportunities, including titles, companies, locations, salaries, and detailed descriptions, directly from RozeePk's search results and individual job pages.

## 🚀 Key Features

- **⚡ Hybrid Architecture**: Uses ultra-fast Cheerio crawler for list pages (10-20x faster) + Playwright only for detail pages requiring JavaScript
- **🎯 Comprehensive Job Data Extraction**: Captures essential job details such as title, company, location, salary, contract type, posting date, and full descriptions
- **💰 Low Memory Footprint**: Cheerio-based list scraping uses 80-90% less memory than full browser automation
- **🔍 Flexible Search Options**: Search by keywords, locations, or categories to target specific job markets in Pakistan
- **📄 Pagination Handling**: Automatically navigates through multiple search result pages with minimal resource usage
- **🎭 Stealth & Anti-Detection**: Fingerprinting, UA rotation, session pooling, proxy support for reliable enterprise scraping
- **📊 Structured Output**: Saves data in clean, consistent JSON format ready for analysis or integration
- **🌐 Proxy Support**: Built-in support for Apify proxies to handle rate limits and ensure reliable scraping
- **📈 Production-Ready**: Optimized for speed, memory efficiency, and large-scale job data collection

## 📋 Input Parameters

Configure the scraper with the following options to customize your job search:

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `keyword` | string | Job title or skill to search for (e.g., "software engineer", "sales executive"). | - |
| `location` | string | Location filter (e.g., "Lahore", "Karachi"). | - |
| `category` | string | Job category to filter by (if supported by RozeePk). | - |
| `startUrl` / `url` / `startUrls` | string/array | Specific RozeePk search URL(s) to start from. Overrides keyword/location if provided. | - |
| `results_wanted` | integer | Maximum number of job listings to collect. | 100 |
| `max_pages` | integer | Maximum number of search pages to visit. | 20 |
| `collectDetails` | boolean | Whether to visit job detail pages for full descriptions. | true |
| `proxyConfiguration` | object | Proxy settings for enhanced scraping reliability. | Apify Proxy recommended |

### Example Input Configuration

```json
{
  "keyword": "software engineer",
  "location": "Lahore",
  "results_wanted": 50,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

## 📊 Output Data Structure

Each scraped job is saved as a JSON object with the following fields:

```json
{
  "title": "Software Engineer",
  "company": "TechCorp",
  "category": "IT",
  "location": "Lahore, Pakistan",
  "salary": "PKR 50,000 - 100,000",
  "contract_type": "Full Time/Permanent",
  "date_posted": "Nov 15, 2025",
  "description_html": "<p>Detailed job description...</p>",
  "description_text": "Plain text version of the job description...",
  "url": "https://www.rozee.pk/job/123456.html"
}
```

- **title**: Job position title
- **company**: Hiring company name
- **category**: Job category (if available)
- **location**: Job location in Pakistan
- **salary**: Salary information (when provided, in PKR)
- **contract_type**: Type of contract (Full Time, Part Time, etc.)
- **date_posted**: Job posting date
- **description_html**: Full job description in HTML format
- **description_text**: Plain text version of the description
- **url**: Direct link to the job posting on RozeePk

## 🛠️ Usage Examples

### Basic Job Search
Run the actor with simple keyword and location inputs to collect recent job listings:

```json
{
  "keyword": "marketing",
  "location": "Karachi",
  "results_wanted": 25
}
```

### Advanced Configuration
For targeted scraping with proxy support:

```json
{
  "startUrls": ["https://www.rozee.pk/job/jsearch/q/data%20analyst"],
  "collectDetails": true,
  "max_pages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Integration with Apify API
Use the Apify API to run the scraper programmatically:

```bash
curl -X POST https://api.apify.com/v2/acts/your-actor-id/runs \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "sales executive", "location": "Lahore", "results_wanted": 100}'
```

## ⚙️ Configuration Best Practices & Memory Requirements

### 💾 Memory Recommendations

**Hybrid Architecture Memory Usage:**
- **Minimum (Development/Testing)**: 2 GB - Supports low concurrency (1-3 jobs at a time)
- **Recommended (Production)**: 4 GB - Optimal for concurrency 5-10 with stable performance
- **High Volume**: 8 GB - For heavy workloads with 15+ concurrent detail page extractions

**Why Hybrid is Faster:**
- **LIST pages**: Cheerio crawler uses ~50-100 MB per page (no browser overhead)
- **DETAIL pages**: Playwright uses ~400-600 MB per browser instance (JavaScript execution required)
- **Overall**: 80-90% memory reduction vs full Playwright scraping

### ⚡ Performance Configuration

- **Proxy Usage**: Always enable proxy configuration to avoid IP blocking and ensure smooth scraping
- **Result Limits**: Set reasonable `results_wanted` values to balance data volume and execution time
- **Detail Scraping**: Enable `collectDetails` for comprehensive data - Playwright only runs for detail pages
- **Concurrency**: CheerioCrawler runs at 20 concurrent requests, PlaywrightCrawler at 10 (auto-optimized)
- **Rate Limiting**: The actor handles rate limits automatically with session pooling

## 🔧 Troubleshooting

### Common Issues
- **No Results Found**: Verify keyword and location spellings. Try broader search terms.
- **Incomplete Data**: Ensure `collectDetails` is enabled for full descriptions.
- **Rate Limiting**: Use proxy configuration to distribute requests.
- **Timeout Errors**: Reduce `results_wanted` or increase timeout settings.

### Performance Tips
- For large datasets, run the actor during off-peak hours.
- Use specific keywords to reduce irrelevant results.
- Monitor dataset size to avoid exceeding Apify storage limits.

## 📈 SEO and Discoverability

This scraper is optimized for finding Pakistani job market data. Keywords include: RozeePk scraper, Pakistani jobs, employment Pakistan, job listings Pakistan, automated job scraping, recruitment data, RozeePk API alternative.

## 🤝 Support and Resources

For questions or issues:
- Check the Apify community forums
- Review RozeePk's terms of service before large-scale scraping
- Ensure compliance with local data protection regulations

*Last updated: November 2025*