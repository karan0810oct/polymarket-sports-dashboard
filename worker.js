
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: cors });

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const arr = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function normalizeMarket(market) {
  return {
    id: market.id ?? null,
    question: market.question ?? market.title ?? "",
    slug: market.slug ?? null,
    conditionId: market.conditionId ?? null,
    active: market.active ?? null,
    closed: market.closed ?? null,
    volume: num(market.volumeNum ?? market.volume),
    liquidity: num(market.liquidityNum ?? market.liquidity),
    outcomes: arr(market.outcomes),
    outcomePrices: arr(market.outcomePrices),
    clobTokenIds: arr(market.clobTokenIds),
    bestBid: market.bestBid ?? null,
    bestAsk: market.bestAsk ?? null,
    spread: market.spread ?? null,
    orderMinSize: market.orderMinSize ?? null,
    orderPriceMinTickSize: market.orderPriceMinTickSize ?? null,
    url: market.slug
      ? `https://polymarket.com/event/${market.slug}`
      : null
  };
}

function normalizeEvent(event) {
  const markets = arr(event.markets).map(normalizeMarket);

  return {
    id: event.id ?? null,
    title: event.title ?? event.name ?? "",
    slug: event.slug ?? null,
    description: event.description ?? "",
    startDate: event.startDate ?? event.startTime ?? null,
    endDate: event.endDate ?? null,
    active: event.active ?? null,
    closed: event.closed ?? null,
    volume: num(event.volumeNum ?? event.volume),
    liquidity: num(event.liquidityNum ?? event.liquidity),
    tags: arr(event.tags).map(tag => ({
      id: tag.id ?? null,
      label: tag.label ?? tag.name ?? tag.slug ?? ""
    })),
    marketCount: markets.length,
    markets,
    marketQuestions: markets.map(m => m.question).filter(Boolean),
    url: event.slug
      ? `https://polymarket.com/event/${event.slug}`
      : null
  };
}

function isRealMatch(event) {
  const title = String(event.title ?? event.name ?? "").trim();
  if (!title) return false;

  // Match titles, not league tables, awards, futures or outright winners.
  const versus = /\b(vs?\.?|versus)\b| @ /i.test(title);
  if (!versus) return false;

  const lower = title.toLowerCase();
  const excluded = [
    "winner of",
    "champion",
    "championship winner",
    "league winner",
    "to win the",
    "ballon d'or",
    "mvp",
    "top scorer",
    "qualify",
    "outright",
    "standings"
  ];

  if (excluded.some(word => lower.includes(word))) return false;
  if (event.closed === true || event.active === false) return false;

  return true;
}

function eventSport(event) {
  const tags = arr(event.tags)
    .map(t => `${t.label ?? ""} ${t.name ?? ""} ${t.slug ?? ""}`)
    .join(" ");

  const text = `${event.title ?? ""} ${event.slug ?? ""} ${tags}`
    .toLowerCase();

  if (/cricket|ipl|t20|test match|odi|ashes/.test(text)) return "Cricket";
  if (/soccer|football|premier league|la liga|champions league|serie a|bundesliga|ligue 1/.test(text)) return "Football";
  if (/tennis|atp|wta|grand slam/.test(text)) return "Tennis";
  if (/mma|ufc|boxing|fight night/.test(text)) return "MMA";
  if (/basketball|nba|wnba|euroleague/.test(text)) return "Basketball";
  if (/american football|nfl|ncaaf/.test(text)) return "American Football";
  if (/baseball|mlb/.test(text)) return "Baseball";
  if (/hockey|nhl/.test(text)) return "Hockey";
  if (/esports|league of legends|dota|valorant|counter-strike|cs2/.test(text)) return "Esports";

  return "Other";
}

async function getBook(tokenId) {
  if (!tokenId) {
    return { bestBid: null, bestAsk: null, backOdds: null, layOdds: null };
  }

  try {
    const book = await getJSON(
      `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`
    );

    const bids = arr(book.bids)
      .map(x => num(x.price))
      .filter(x => x > 0 && x < 1);

    const asks = arr(book.asks)
      .map(x => num(x.price))
      .filter(x => x > 0 && x < 1);

    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestAsk = asks.length ? Math.min(...asks) : null;

    return {
      bestBid,
      bestAsk,
      // Decimal odds are indicative conversions from binary share prices.
      backOdds: bestAsk ? Number((1 / bestAsk).toFixed(3)) : null,
      layOdds: bestBid ? Number((1 / bestBid).toFixed(3)) : null
    };
  } catch {
    return {
      bestBid: null,
      bestAsk: null,
      backOdds: null,
      layOdds: null
    };
  }
}

async function addQuotes(event) {
  const markets = arr(event.markets);
  const resultMarkets = [];

  for (const original of markets.slice(0, 3)) {
    const market = normalizeMarket(original);
    const outcomes = market.outcomes;
    const tokens = market.clobTokenIds;

    const quotes = await Promise.all(
      tokens.slice(0, 3).map(token => getBook(token))
    );

    market.quotes = tokens.slice(0, 3).map((tokenId, index) => ({
      tokenId,
      outcome: outcomes[index] ?? `Outcome ${index + 1}`,
      ...(quotes[index] ?? {
        bestBid: null,
        bestAsk: null,
        backOdds: null,
        layOdds: null
      })
    }));

    resultMarkets.push(market);
  }

  return {
    ...normalizeEvent(event),
    sport: eventSport(event),
    markets: resultMarkets,
    updatedAt: new Date().toISOString()
  };
}

async function getEventsPage(limit, offset, extra = "") {
  const url =
    `${GAMMA}/events?active=true&closed=false` +
    `&limit=${limit}&offset=${offset}${extra}`;

  const data = await getJSON(url);
  return Array.isArray(data) ? data : [];
}

async function getMatches(limit, offset, sportFilter) {
  const sports = await getJSON(`${GAMMA}/sports`).catch(() => []);
  const sportsList = Array.isArray(sports) ? sports : [];

  const seriesIds = [
    ...new Set(
      sportsList.flatMap(sport => {
        const series = arr(sport.series);
        return series.map(s => String(s.id ?? s.series_id ?? "")).filter(Boolean);
      })
    )
  ].slice(0, 15);

  // Fetch generic event pages and selected sports series in parallel.
  const tasks = [
    getEventsPage(100, 0).catch(() => []),
    getEventsPage(100, 100).catch(() => []),
    getEventsPage(100, 200).catch(() => []),
    ...seriesIds.map(id =>
      getJSON(
        `${GAMMA}/events?series_id=${encodeURIComponent(id)}` +
        `&active=true&closed=false&limit=50`
      ).catch(() => [])
    )
  ];

  const batches = await Promise.all(tasks);
  const byId = new Map();

  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;

    for (const event of batch) {
      const id = String(event.id ?? event.slug ?? "");
      if (id) byId.set(id, event);
    }
  }

  let events = [...byId.values()].filter(isRealMatch);

  if (sportFilter && sportFilter !== "all") {
    const wanted = sportFilter.toLowerCase();
    events = events.filter(e => eventSport(e).toLowerCase() === wanted);
  }

  events.sort((a, b) => {
    const aDate = Date.parse(a.startDate ?? a.startTime ?? "") || 0;
    const bDate = Date.parse(b.startDate ?? b.startTime ?? "") || 0;
    return aDate - bDate;
  });

  const total = events.length;
  const page = events.slice(offset, offset + limit);

  // Avoid excessive CLOB requests: quote at most 12 event cards per response.
  const data = [];
  for (const event of page.slice(0, 12)) {
    data.push(await addQuotes(event));
  }

  // Remaining matches still appear, with market metadata but no book requests.
  for (const event of page.slice(12)) {
    data.push({
      ...normalizeEvent(event),
      sport: eventSport(event),
      updatedAt: new Date().toISOString()
    });
  }

  return {
    success: true,
    provider: "Polymarket Gamma + public CLOB",
    type: "matches",
    limit,
    offset,
    scanned: byId.size,
    count: data.length,
    totalMatchesFound: total,
    quoteNote: "Decimal odds are derived from available CLOB best ask/bid prices. Missing quotes remain null.",
    updatedAt: new Date().toISOString(),
    data
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return json({ success: false, error: "Only GET and OPTIONS are supported" }, 405);
    }

    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("limit")) || 50)
    );
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

    try {
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          status: "ok",
          worker: "crystal-odds-api",
          provider: "Polymarket Gamma + public CLOB",
          endpoints: [
            "/health",
            "/sports",
            "/matches?limit=50&offset=0",
            "/polymarket?type=events&limit=50&offset=0",
            "/polymarket?type=markets&limit=50&offset=0",
            "/events?limit=50&offset=0",
            "/markets?limit=50&offset=0",
            "/event?id=EVENT_ID",
            "/event?slug=EVENT_SLUG",
            "/market?id=MARKET_ID",
            "/market?slug=MARKET_SLUG"
          ],
          updatedAt: new Date().toISOString()
        });
      }

      if (path === "/sports") {
        const data = await getJSON(`${GAMMA}/sports`);
        return json({
          success: true,
          provider: "Polymarket Gamma",
          count: Array.isArray(data) ? data.length : 0,
          updatedAt: new Date().toISOString(),
          data
        });
      }

      if (path === "/matches") {
        const sport = url.searchParams.get("sport") || "all";
        return json(await getMatches(limit, offset, sport));
      }

      if (
        path === "/events" ||
        (path === "/polymarket" &&
          (url.searchParams.get("type") || "events") === "events")
      ) {
        const query = new URLSearchParams({
          limit: String(limit),
          offset: String(offset)
        });

        for (const key of ["active", "closed", "order", "ascending", "tag_slug", "series_id", "slug", "id"]) {
          const value = url.searchParams.get(key);
          if (value !== null) query.set(key, value);
        }

        const data = await getJSON(`${GAMMA}/events?${query.toString()}`);
        const items = Array.isArray(data) ? data : [];

        return json({
          success: true,
          provider: "Polymarket Gamma",
          type: "events",
          limit,
          offset,
          count: items.length,
          updatedAt: new Date().toISOString(),
          data: items.map(normalizeEvent)
        });
      }

      if (
        path === "/markets" ||
        (path === "/polymarket" &&
          url.searchParams.get("type") === "markets")
      ) {
        const query = new URLSearchParams({
          limit: String(limit),
          offset: String(offset)
        });

        for (const key of ["active", "closed", "order", "ascending", "slug", "id"]) {
          const value = url.searchParams.get(key);
          if (value !== null) query.set(key, value);
        }

        const data = await getJSON(`${GAMMA}/markets?${query.toString()}`);
        const items = Array.isArray(data) ? data : [];

        return json({
          success: true,
          provider: "Polymarket Gamma",
          type: "markets",
          limit,
          offset,
          count: items.length,
          updatedAt: new Date().toISOString(),
          data: items.map(normalizeMarket)
        });
      }

      if (path === "/event") {
        const id = url.searchParams.get("id");
        const slug = url.searchParams.get("slug");

        if (!id && !slug) {
          return json({
            success: false,
            error: "Provide ?id=EVENT_ID or ?slug=EVENT_SLUG"
          }, 400);
        }

        const endpoint = id
          ? `${GAMMA}/events?id=${encodeURIComponent(id)}`
          : `${GAMMA}/events?slug=${encodeURIComponent(slug)}`;

        const data = await getJSON(endpoint);
        const event = Array.isArray(data) ? data[0] : data;

        if (!event) return json({ success: false, error: "Event not found" }, 404);

        return json({
          success: true,
          provider: "Polymarket Gamma",
          data: normalizeEvent(event),
          updatedAt: new Date().toISOString()
        });
      }

      if (path === "/market") {
        const id = url.searchParams.get("id");
        const slug = url.searchParams.get("slug");

        if (!id && !slug) {
          return json({
            success: false,
            error: "Provide ?id=MARKET_ID or ?slug=MARKET_SLUG"
          }, 400);
        }

        const endpoint = id
          ? `${GAMMA}/markets?id=${encodeURIComponent(id)}`
          : `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`;

        const data = await getJSON(endpoint);
        const market = Array.isArray(data) ? data[0] : data;

        if (!market) return json({ success: false, error: "Market not found" }, 404);

        const normalized = normalizeMarket(market);
        const quotes = await Promise.all(
          normalized.clobTokenIds.map(token => getBook(token))
        );

        normalized.quotes = normalized.clobTokenIds.map((tokenId, index) => ({
          tokenId,
          outcome: normalized.outcomes[index] ?? `Outcome ${index + 1}`,
          ...quotes[index]
        }));

        return json({
          success: true,
          provider: "Polymarket Gamma + public CLOB",
          data: normalized,
          updatedAt: new Date().toISOString()
        });
      }

      if (path === "/polymarket") {
        return json({
          success: false,
          error: "Invalid type. Use ?type=events or ?type=markets."
        }, 400);
      }

      return json({
        success: false,
        error: "Endpoint not found",
        path,
        available: ["/health", "/sports", "/matches", "/polymarket", "/events", "/markets", "/event", "/market"]
      }, 404);
    } catch (error) {
      return json({
        success: false,
        error: error instanceof Error ? error.message : "Upstream request failed",
        endpoint: path,
        updatedAt: new Date().toISOString()
      }, 502);
    }
  }
};
