import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';
import { searchMemories, storeMemory } from '../memory/memoryService.js';
import { validateExternalUrl } from '../security/guard.js';

export interface BrowserInspectResult {
  url: string;
  status: number;
  title: string;
  description: string;
  textExcerpt: string;
  links: Array<{ text: string; href: string }>;
  formsCount: number;
  captchaDetected: boolean;
  mfaDetected: boolean;
  requiresOwnerAssistance: boolean;
  fetchedAt: string;
}

const CAPTCHA_MARKERS = ['recaptcha', 'hcaptcha', 'cf-turnstile', 'verify you are human', 'g-recaptcha'];
const MFA_MARKERS = ['two-factor', '2fa verification', 'authenticator code', 'one-time passcode', 'enter otp'];

export async function inspectWebPage(rawUrl: string): Promise<BrowserInspectResult> {
  const safeUrl = validateExternalUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(safeUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'JARVIS-BrowserAgent/1.0 (Authorized Research)',
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json',
      },
      redirect: 'follow',
    });

    // Validate final redirected URL against SSRF as well
    if (res.url) {
      validateExternalUrl(res.url);
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    $('script, style, noscript').remove();
    const title = $('title').first().text().trim() || safeUrl.hostname;
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';
    const textExcerpt = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);

    const links: Array<{ text: string; href: string }> = [];
    $('a[href]').each((_, el) => {
      if (links.length >= 25) return;
      const href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
        try {
          const resolved = new URL(href, safeUrl.toString()).toString();
          links.push({ text: text.slice(0, 80) || resolved, href: resolved });
        } catch {
          // ignore malformed href
        }
      }
    });

    const formsCount = $('form').length;
    const lowerHtml = html.toLowerCase();
    const captchaDetected = CAPTCHA_MARKERS.some((m) => lowerHtml.includes(m));
    const mfaDetected = MFA_MARKERS.some((m) => lowerHtml.includes(m));

    logAudit('info', 'browser_agent', 'page_inspected', {
      url: safeUrl.toString(),
      status: res.status,
      captchaDetected,
      mfaDetected,
    });

    return {
      url: res.url || safeUrl.toString(),
      status: res.status,
      title,
      description,
      textExcerpt,
      links,
      formsCount,
      captchaDetected,
      mfaDetected,
      requiresOwnerAssistance: captchaDetected || mfaDetected,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResearchReport {
  id: string;
  query: string;
  mode: 'online' | 'offline';
  summary: string;
  sources: Array<{ title: string; url: string; reliability: string; excerpt: string }>;
  contradictions: string[];
  createdAt: string;
}

export async function conductResearch(
  query: string,
  options?: { urls?: string[]; onlineAllowed?: boolean }
): Promise<ResearchReport> {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const sources: ResearchReport['sources'] = [];
  const contradictions: string[] = [];

  // 1. Always search local knowledge & memories first
  const localMemories = searchMemories(query, 6);
  for (const mem of localMemories) {
    sources.push({
      title: `[Local Memory] ${mem.title}`,
      url: `memory://${mem.id}`,
      reliability: `local (${Math.round(mem.confidence * 100)}% confidence)`,
      excerpt: mem.content.slice(0, 300),
    });
  }

  let mode: 'online' | 'offline' = 'offline';

  // 2. If online allowed and URLs or DuckDuckGo/Wikipedia public endpoints are queried
  if (options?.onlineAllowed !== false) {
    if (options?.urls && options.urls.length > 0) {
      for (const rawUrl of options.urls.slice(0, 4)) {
        try {
          const page = await inspectWebPage(rawUrl);
          mode = 'online';
          sources.push({
            title: page.title,
            url: page.url,
            reliability: page.requiresOwnerAssistance
              ? 'blocked_by_captcha_or_mfa'
              : `http_${page.status}`,
            excerpt: page.textExcerpt.slice(0, 400),
          });
        } catch (err) {
          contradictions.push(
            `Failed to fetch ${rawUrl}: ${err instanceof Error ? err.message : 'network error'}`
          );
        }
      }
    } else {
      // Query Wikipedia REST summary API for factual grounding when no explicit URLs given
      try {
        const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          query.trim().replace(/\s+/g, '_')
        )}`;
        const res = await fetch(wikiUrl, {
          headers: { 'User-Agent': 'JARVIS-Research/1.0' },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            title?: string;
            extract?: string;
            content_urls?: { desktop?: { page?: string } };
          };
          if (data.extract) {
            mode = 'online';
            sources.push({
              title: data.title || query,
              url: data.content_urls?.desktop?.page || wikiUrl,
              reliability: 'encyclopedic_reference',
              excerpt: data.extract,
            });
          }
        }
      } catch {
        // Offline or unreachable — remain in offline mode honestly
      }
    }
  }

  const summary =
    sources.length > 0
      ? `Gathered ${sources.length} source(s) (${mode} mode) for "${query}". ${sources
          .map((s) => `${s.title}: ${s.excerpt.slice(0, 180)}`)
          .join(' | ')}`
      : `No matching local records found and online sources were unavailable/unreached for "${query}".`;

  db.prepare(
    'INSERT INTO research_reports (id, query, mode, summary, sources_json, contradictions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    query,
    mode,
    summary,
    JSON.stringify(sources),
    JSON.stringify(contradictions),
    createdAt
  );

  if (sources.length > 0) {
    storeMemory({
      category: 'fact',
      title: `Research: ${query.slice(0, 60)}`,
      content: summary.slice(0, 1500),
      source: `research:${id}`,
      context: `${mode} research with ${sources.length} cited source(s)`,
      importance: 0.7,
    });
  }

  return { id, query, mode, summary, sources, contradictions, createdAt };
}

export function listResearchReports(limit = 25): ResearchReport[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM research_reports ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    query: String(r.query),
    mode: String(r.mode) as 'online' | 'offline',
    summary: String(r.summary),
    sources: JSON.parse(String(r.sources_json || '[]')),
    contradictions: JSON.parse(String(r.contradictions_json || '[]')),
    createdAt: String(r.created_at),
  }));
}
