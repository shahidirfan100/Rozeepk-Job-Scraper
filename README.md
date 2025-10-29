
# Rozee.pk Job Scraper

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com/apify/rozee-pk-jobs-scraper)

A powerful Apify actor that automatically scrapes comprehensive job listings from Rozee.pk, Pakistan's leading job portal. This actor collects detailed job information including titles, companies, locations, salaries, and full descriptions from both listing and detail pages.

## ✨ Features

- **Comprehensive Data Extraction**: Captures all key job details including title, company, location, posting date, job type, category, salary, and descriptions
- **Automatic Pagination**: Seamlessly navigates through multiple pages of job listings
- **Dual Description Formats**: Extracts job descriptions in both HTML and plain text formats
- **Proxy Support**: Built-in support for Apify proxy rotation to handle rate limits and IP blocking
- **Reliable Scraping**: Implements retry logic and error handling for robust data collection
- **Structured Output**: Saves data in clean, structured JSON format ready for analysis

## 📥 Input

The actor accepts the following input parameters:

### Basic Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `startUrls` | Array | No | `["https://www.rozee.pk/job/jsearch/q/all"]` | Array of Rozee.pk job search URLs to start scraping from |
| `maxItems` | Integer | No | 100 | Maximum number of job listings to collect |
| `proxyConfiguration` | Object | No | Residential proxy | Apify proxy configuration for reliable scraping |

### Advanced Options

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `keyword` | String | No | - | Job search keyword (for compatibility, but Rozee.pk uses URL-based search) |
| `location` | String | No | - | Location filter (optional) |
| `category` | String | No | - | Job category filter (optional) |
| `collectDetails` | Boolean | No | `true` | Whether to visit detail pages for full descriptions |
| `results_wanted` | Integer | No | 100 | Alternative to `maxItems` |
| `max_pages` | Integer | No | 999 | Maximum pages to scrape |
| `cookies` | String | No | - | Custom cookies for authentication |
| `cookiesJson` | String | No | - | Cookies in JSON format |
| `dedupe` | Boolean | No | `true` | Remove duplicate job listings |

## 📤 Output

Each scraped job is saved as a structured JSON object in the Apify dataset:

```json
{
  "title": "Senior Software Engineer",
  "company": "Tech Solutions Pakistan",
  "location": "Lahore, Pakistan",
  "date_posted": "2025-10-29",
  "job_type": "Full-time",
  "job_category": "Information Technology",
  "salary": "PKR 150,000 - 250,000",
  "description_html": "<div><p>We are looking for a Senior Software Engineer...</p></div>",
  "description_text": "We are looking for a Senior Software Engineer...",
  "job_url": "https://www.rozee.pk/company/job-12345"
}
```

### Output Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Job position title |
| `company` | String | Company/employer name |
| `location` | String | Job location (city, country) |
| `date_posted` | String | Posting date (YYYY-MM-DD format) |
| `job_type` | String | Employment type (Full-time, Part-time, Contract, etc.) |
| `job_category` | String | Job industry/category |
| `salary` | String | Salary range or information (if available) |
| `description_html` | String | Full job description in HTML format |
| `description_text` | String | Job description in plain text |
| `job_url` | String | Direct link to the job posting |

## 🚀 Usage

### Running on Apify Platform

1. **Create a new task** in your Apify account
2. **Search for "rozee-pk-jobs-scraper"** or use the actor URL
3. **Configure input parameters** (see Input section above)
4. **Run the actor** and monitor progress
5. **Download results** from the dataset in JSON, CSV, or Excel format

### Example Input Configuration

```json
{
  "startUrls": [
    "https://www.rozee.pk/job/jsearch/q/all",
    "https://www.rozee.pk/job/jsearch/q/software-engineer"
  ],
  "maxItems": 500,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Local Development

For local testing and development:

1. Clone this repository
2. Install dependencies: `npm install`
3. Set up input in `INPUT.json`
4. Run locally: `npm start`

## ⚙️ Configuration

### Proxy Settings

For best results, configure Apify proxy:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"],
    "apifyProxyCountry": "PK"
  }
}
```

### Rate Limiting

The actor automatically handles rate limiting, but you can adjust:

- Use residential proxies for higher success rates
- Set reasonable `maxItems` limits (recommended: 100-1000 per run)
- Monitor actor logs for retry attempts

### Custom Start URLs

To scrape specific job categories or locations:

```
https://www.rozee.pk/job/jsearch/q/all
https://www.rozee.pk/job/jsearch/q/marketing
https://www.rozee.pk/job/jsearch/q/lahore
```

## 📊 Limits & Costs

- **Free tier**: Up to 100 jobs per run
- **Paid plans**: Unlimited jobs with higher concurrency
- **Rate limits**: Automatically handled with proxy rotation
- **Data retention**: Results stored for 7 days on free tier

## 🔧 Troubleshooting

### Common Issues

**Low success rate:**
- Enable residential proxies
- Reduce concurrency if needed
- Check Rozee.pk website availability

**Missing descriptions:**
- Ensure `collectDetails` is set to `true`
- Some jobs may not have detailed descriptions

**Rate limiting:**
- Use proxy rotation
- Add delays between requests (configured automatically)

### Support

For issues or questions:
- Check Apify actor logs for detailed error messages
- Verify input parameters are correctly formatted
- Ensure Rozee.pk website structure hasn't changed

## 📝 Changelog

### Version 1.0.0
- Initial release
- Full Rozee.pk job scraping functionality
- Support for pagination and detail extraction
- Proxy rotation and retry logic

## 📄 License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.

---

**Note**: This actor is designed for personal and commercial use on the Apify platform. Please respect Rozee.pk's terms of service and robots.txt when using this scraper.