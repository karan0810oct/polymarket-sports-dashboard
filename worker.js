
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const WORKER_NAME = "crystal-odds-api";
const MAX_SPREAD = 0.20;

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    }
  });
}

function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }
  return [];
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "CrystalEdge-Worker/1.0"
    },
    signal: AbortSignal.timeout(12000)
  });
  const raw = await r.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { message: raw.slice(0, 500) }; }
  if (!r.ok) {
    const e = new Error(`Upstream HTTP ${r.status}`);
    e.status = r.status;
    e.details = data;
    throw e;
  }
  return data;
}

function gammaURL(resource, params = {}) {
  const u = new URL(`${GAMMA}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// Tags take priority over title text.
// This prevents a tennis event from being labelled Cricket.
function eventSport(event) {
  const tags = arr(event.tags).map(t =>
    String(typeof t === "string" ? t : (t.label || t.name || t.slug || ""))
      .toLowerCase().trim()
  );
  const text = [
    event.title, event.slug, event.description,
    ...tags
  ].filter(Boolean).join(" ").toLowerCase();

  const hasTag = pattern => tags.some(t => pattern.test(t));

  if (hasTag(/^cricket$|international cricket|domestic cricket/) ||
      /\b(cricket|ipl|t20|odi|test match|the ashes)\b/.test(text)) return "Cricket";

  if (hasTag(/^tennis$|^atp$|^wta$/) ||
      /\b(tennis|atp|wta|grand slam|wimbledon|roland garros)\b/.test(text)) return "Tennis";

  if (hasTag(/^mma$|^ufc$|^boxing$/) ||
      /\b(mma|ufc|boxing|fight night)\b/.test(text)) return "MMA";

  if (hasTag(/^basketball$|^nba$|^wnba$/) ||
      /\b(basketball|nba|wnba|euroleague)\b/.test(text)) return "Basketball";

  if (hasTag(/^soccer$|^football$/) ||
      /\b(soccer|football|premier league|la liga|champions league|serie a|bundesliga|ligue 1|fa cup)\b/.test(text)) return "Football";

  if (hasTag(/^american football$|^nfl$/) ||
      /\b(nfl|american football)\b/.test(text)) return "American Football";

  if (hasTag(/^baseball$|^mlb$/) || /\b(baseball|mlb)\b/.test(text)) return "Baseball";
  if (hasTag(/^hockey$|^nhl$/) || /\b(ice hockey|nhl)\b/.test(text)) return "Hockey";

  if (hasTag(/^esports$|^esport$/) ||
      /\b(esports|counter-strike|cs2|league of legends|dota 2|valorant|map \d winner)\b/.test(text)) return "Esports";

  return "Other";
}

function requestedSport(value) {
  const s = String(value || "all").toLowerCase().trim();
  const aliases = {
    soccer: "Football",
    football: "Football",
    cricket: "Cricket",
    tennis: "Tennis",
    mma: "MMA",
    ufc: "MMA",
    basketball: "Basketball",
    esports: "Esports",
    "american-football": "American Football",
    baseball: "Baseball",
    hockey: "Hockey",
    all: "all"
  };
  return aliases[s] || "all";
}

function looksLikeMatch(title) {
  const t = String(title || "").trim();
  if (!t) return false;

  // Avoid outrights, league winners and player award markets.
  if (/\b(winner of the|champion|championship winner|outright|ballon d'or|mvp|top scorer|relegated|to qualify|group winner)\b/i.test(t)) return false;

  // Prefer actual head-to-head event titles.
  return /\bvs\.?\b|\bversus\b|\bv\.\b/i.test(t);
}

function marketScore(market) {
  const q = String(market.question || market.title || "").toLowerCase();
  let score = 0;

  if (/\b(match winner|moneyline|winner)\b/.test(q)) score += 10;
  if (/\b(map|set|quarter|period|half|innings|inning|round)\s*\d*\b/.test(q)) score -= 30;
  if (/\b(total|over\/under|spread|handicap|correct score|first to|first scorer|toss|top batter|top bowler)\b/.test(q)) score -= 20;
  if (/\b(yes|no)\b/.test(q)) score -= 5;

  const outcomes = arr(market.outcomes);
  if (outcomes.length === 2 && !outcomes.every(x => /^(yes|no)$/i.test(String(x)))) score += 5;
  if (arr(market.clobTokenIds || market.clob_token_ids).length >= 2) score += 3;
  return score;
}

async function getBook(tokenId) {
  if (!tokenId) return {
    bestBid: null, bestAsk: null, spread: null,
    backOdds: null, layOdds: null, quoteStatus: "unavailable"
  };

  try {
    const book = await fetchJSON(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
    const bids = arr(book.bids).map(x => num(x.price)).filter(x => x !== null && x > 0 && x < 1);
    const asks = arr(book.asks).map(x => num(x.price)).filter(x => x !== null && x > 0 && x < 1);

    const bid = bids.length ? Math.max(...bids) : null;
    const ask = asks.length ? Math.min(...asks) : null;
    const spread = bid !== null && ask !== null ? Number((ask - bid).toFixed(6)) : null;

    // Wide spreads are not presented as trustworthy odds.
    const reliable = bid !== null && ask !== null &&
      ask >= bid && spread !== null && spread <= MAX_SPREAD;

    return {
      bestBid: reliable ? bid : null,
      bestAsk: reliable ? ask : null,
      spread,
      backOdds: reliable ? Number((1 / ask).toFixed(3)) : null,
      layOdds: reliable ? Number((1 / bid).toFixed(3)) : null,
      quoteStatus: reliable ? "live" : "no_reliable_quote"
    };
  } catch {
    return {
      bestBid: null, bestAsk: null, spread: null,
      backOdds: null, layOdds: null, quoteStatus: "unavailable"
    };
  }
}

async function enrichMarket(market, withQuotes = false) {
  const outcomes = arr(market.outcomes);
  const tokens = arr(market.clobTokenIds || market.clob_token_ids);
  const prices = arr(market.outcomePrices || market.outcome_prices);

  const quotes = [];
  for (let i = 0; i < outcomes.length; i++) {
    const q = withQuotes && tokens[i]
      ? await getBook(tokens[i])
      : {
          bestBid: null, bestAsk: null, spread: null,
          backOdds: null, layOdds: null, quoteStatus: "not_requested"
        };

    quotes.push({
      tokenId: tokens[i] || null,
      outcome: String(outcomes[i]),
      ...q,
      // Gamma price is a probability reference, not a live executable quote.
      probability: num(prices[i])
    });
  }

  return {
    ...market,
    outcomes: outcomes.map(String),
    clobTokenIds: tokens,
    quotes,
    bestBid: null,
    bestAsk: null,
    spread: null,
    updatedAt: market.updatedAt || market.updated_at || null
  };
}

async function getMatches(limit, offset, sportParam) {
  const targetSport = requestedSport(sportParam);
  const scannedEvents = [];
  const pageSize = 100;
  const pagesToScan = 5;

  for (let page = 0; page < pagesToScan; page++) {
    const raw = await fetchJSON(gammaURL("events", {
      active: true,
      closed: false,
      limit: pageSize,
      offset: page * pageSize,
      order: "startDate",
      ascending: true,
      tag_slug: undefined
    }));
    const rows = Array.isArray(raw) ? raw : arr(raw?.data);
    if (!rows.length) break;
    scannedEvents.push(...rows);
    if (rows.length < pageSize) break;
  }

  const now = Date.now();
  const filtered = scannedEvents.filter(event => {
    if (event.active === false || event.closed === true) return false;
    if (!looksLikeMatch(event.title)) return false;

    const sport = eventSport(event);
    if (targetSport !== "all" && sport !== targetSport) return false;

    // Remove fixtures that have been over for a long time.
    const start = Date.parse(event.startDate || event.start_date || "");
    if (Number.isFinite(start) && start < now - 12 * 60 * 60 * 1000) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const da = Date.parse(a.startDate || a.start_date || "") || Infinity;
    const db = Date.parse(b.startDate || b.start_date || "") || Infinity;
    return da - db;
  });

  const matches = [];
  for (const event of filtered) {
    const markets = arr(event.markets).filter(m =>
      m.active !== false && m.closed !== true &&
      arr(m.outcomes).length >= 2 &&
      arr(m.clobTokenIds || m.clob_token_ids).length >= 2
    );
    if (!markets.length) continue;

    // Select the likely full-match winner, not a map/set/quarter sub-market.
    markets.sort((a, b) => marketScore(b) - marketScore(a));
    const selected = markets.find(m => marketScore(m) >= 0) || markets[0];
    if (!selected) continue;

    const market = await enrichMarket(selected, true);
    const sport = eventSport(event);

    matches.push({
      id: String(event.id || event.eventId || selected.id || ""),
      title: event.title || selected.question || "",
      slug: event.slug || selected.slug || "",
      description: event.description || "",
      startDate: event.startDate || event.start_date || null,
      endDate: event.endDate || event.end_date || null,
      active: event.active !== false,
      closed: event.closed === true,
      sport,
      volume: num(event.volume) ?? num(selected.volume) ?? 0,
      liquidity: num(event.liquidity) ?? num(selected.liquidity) ?? 0,
      marketCount: markets.length,
      markets: [market],
      marketQuestions: [selected.question || selected.title || ""],
      url: event.slug ? `https://polymarket.com/event/${event.slug}` :
        (selected.slug ? `https://polymarket.com/event/${selected.slug}` : null),
      updatedAt: new Date().toISOString()
    });
  }

  const totalMatchesFound = matches.length;
  return {
    success: true,
    provider: "Polymarket Gamma + public CLOB",
    type: "matches",
    limit,
    offset,
    scanned: scannedEvents.length,
    count: matches.slice(offset, offset + limit).length,
    totalMatchesFound,
    quoteNote: "Only narrow, verified public CLOB quotes are shown. Missing or wide-spread quotes remain null. Decimal conversions are indicative, not bookmaker odds.",
    updatedAt: new Date().toISOString(),
    data: matches.slice(offset, offset + limit)
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return json({ success: false, error: "Use GET" }, 405, origin);
    }

    const get = (key, fallback = "") => (url.searchParams.get(key) || fallback).trim();
    const limit = int(get("limit", "50"), 50, 1, 100);
    const offset = int(get("offset", "0"), 0, 0, 1000000);

    try {
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          status: "ok",
          worker: WORKER_NAME,
          provider: "Polymarket public APIs only",
          providers: { polymarketGamma: true, polymarketClobPublic: true },
          endpoints: [
            "/health", "/sports",
            "/matches?limit=50&offset=0",
            "/matches?limit=50&offset=0&sport=cricket",
            "/events?limit=100&offset=0",
            "/markets?limit=100&offset=0",
            "/polymarket?type=events&limit=100&offset=0",
            "/polymarket?type=markets&limit=100&offset=0",
            "/event?id=EVENT_ID", "/event?slug=EVENT_SLUG",
            "/market?id=MARKET_ID", "/book?token_id=TOKEN_ID",
            "/price?token_id=TOKEN_ID&side=BUY"
          ],
          updatedAt: new Date().toISOString()
        }, 200, origin);
      }

      if (path === "/sports") {
        const data = await fetchJSON(`${GAMMA}/sports`);
        return json({
          success: true,
          provider: "Polymarket Gamma",
          count: Array.isArray(data) ? data.length : 0,
          data: Array.isArray(data) ? data : []
        }, 200, origin);
      }

      if (path === "/matches") {
        const result = await getMatches(limit, offset, get("sport", "all"));
        return json(result, 200, origin);
      }

      if (["/events", "/markets", "/polymarket"].includes(path)) {
        let type = path === "/events" ? "events" :
          path === "/markets" ? "markets" : get("type", "events").toLowerCase();

        if (!["events", "markets"].includes(type)) {
          return json({ success: false, error: "Use type=events or type=markets" }, 400, origin);
        }

        const params = {
          active: get("active", "true"),
          closed: get("closed", "false"),
          limit, offset,
          order: get("order", "volume24hr"),
          ascending: get("ascending", "false")
        };

        for (const key of ["tag_id", "tag_slug", "series_id", "slug", "id"]) {
          if (get(key)) params[key] = get(key);
        }

        const raw = await fetchJSON(gammaURL(type, params));
        const rows = Array.isArray(raw) ? raw : arr(raw?.data);
        const data = type === "markets"
          ? await Promise.all(rows.map(m => enrichMarket(m, false)))
          : rows;

        return json({
          success: true,
          provider: "Polymarket Gamma",
          type, limit, offset,
          count: data.length,
          hasMore: data.length === limit,
          nextOffset: data.length === limit ? offset + data.length : null,
          updatedAt: new Date().toISOString(),
          data
        }, 200, origin);
      }

      if (path === "/event" || path === "/market") {
        const kind = path === "/event" ? "events" : "markets";
        const id = get("id");
        const slug = get("slug");
        if (!id && !slug) {
          return json({ success: false, error: "Provide id or slug" }, 400, origin);
        }
        const target = id
          ? `${GAMMA}/${kind}/${encodeURIComponent(id)}`
          : `${GAMMA}/${kind}/slug/${encodeURIComponent(slug)}`;
        const raw = await fetchJSON(target);
        const data = kind === "markets"
          ? await enrichMarket(raw, true)
          : {
              ...raw,
              markets: await Promise.all(arr(raw?.markets).map(m => enrichMarket(m, true)))
            };
        return json({ success: true, provider: "Polymarket Gamma + public CLOB", data, updatedAt: new Date().toISOString() }, 200, origin);
      }

      if (path === "/book") {
        const tokenId = get("token_id", get("tokenId"));
        if (!tokenId) return json({ success: false, error: "Provide token_id" }, 400, origin);
        const data = await fetchJSON(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
        return json({ success: true, provider: "Polymarket CLOB", token_id: tokenId, updatedAt: new Date().toISOString(), data }, 200, origin);
      }

      if (path === "/price") {
        const tokenId = get("token_id", get("tokenId"));
        const side = get("side", "BUY").toUpperCase();
        if (!tokenId) return json({ success: false, error: "Provide token_id" }, 400, origin);
        if (!["BUY", "SELL"].includes(side)) {
          return json({ success: false, error: "side must be BUY or SELL" }, 400, origin);
        }
        const data = await fetchJSON(`${CLOB}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`);
        const p = num(data?.price);
        return json({
          success: true, provider: "Polymarket CLOB",
          token_id: tokenId, side,
          price: p,
          decimalOdds: p !== null && p > 0 ? Number((1 / p).toFixed(3)) : null,
          updatedAt: new Date().toISOString(),
          data
        }, 200, origin);
      }

      return json({
        success: false,
        error: "Endpoint not found",
        endpoints: ["/health", "/sports", "/matches", "/events", "/markets", "/polymarket", "/event", "/market", "/book", "/price"]
      }, 404, origin);
    } catch (error) {
      return json({
        success: false,
        error: "Worker request failed",
        details: String(error?.message || error),
        upstreamStatus: error?.status || 502,
        updatedAt: new Date().toISOString()
      }, error?.status && error.status >= 400 && error.status < 600 ? error.status : 502, origin);
    }
  }
};
