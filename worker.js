
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

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const arr = value => {
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

const intParam = (value, fallback, max = 100) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : fallback;
};

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
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
      label: typeof tag === "string"
        ? tag
        : tag.label ?? tag.name ?? tag.slug ?? ""
    })),
    marketCount: markets.length,
    markets,
    marketQuestions: markets.map(m => m.question).filter(Boolean),
    url: event.slug
      ? `https://polymarket.com/event/${event.slug}`
      : null
  };
}

function eventSport(event) {
  const tags = arr(event.tags)
    .map(tag => typeof tag === "string"
      ? tag
      : `${tag.label ?? ""} ${tag.name ?? ""} ${tag.slug ?? ""}`)
    .join(" ");

  const text =
    `${event.title ?? ""} ${event.slug ?? ""} ${tags}`.toLowerCase();

  if (/cricket|ipl|t20|test match|odi|ashes|crint/.test(text)) {
    return "Cricket";
  }

  if (/soccer|football|premier league|la liga|champions league|serie a|bundesliga|ligue 1|wsl/.test(text)) {
    return "Football";
  }

  if (/tennis|atp|wta|grand slam/.test(text)) return "Tennis";
  if (/mma|ufc|boxing|fight night/.test(text)) return "MMA";
  if (/basketball|nba|wnba|euroleague/.test(text)) return "Basketball";
  if (/american football|nfl|ncaaf/.test(text)) return "American Football";
  if (/baseball|mlb/.test(text)) return "Baseball";
  if (/hockey|nhl/.test(text)) return "Hockey";
  if (/esports|league of legends|dota|valorant|counter-strike|cs2/.test(text)) {
    return "Esports";
  }

  return "Other";
}

async function getBook(tokenId) {
  if (!tokenId) {
    return {
      bestBid: null,
      bestAsk: null,
      backOdds: null,
      layOdds: null
    };
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

async function addMarketQuotes(original) {
  const market = normalizeMarket(original);
  const tokens = market.clobTokenIds;
  const outcomes = market.outcomes;

  const quotes = await Promise.all(
    tokens.slice(0, 3).map(token => getBook(token))
  );

  return {
    ...market,
    quotes: tokens.slice(0, 3).map((tokenId, index) => ({
      tokenId,
      outcome: outcomes[index] ?? `Outcome ${index + 1}`,
      ...(quotes[index] ?? {
        bestBid: null,
        bestAsk: null,
        backOdds: null,
        layOdds: null
      })
    }))
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
  const now = Date.now();

  const pages = await Promise.all(
    [0, 100, 200].map(async pageOffset => {
      try {
        return await getEventsPage(
          100,
          pageOffset,
          "&order=id&ascending=false"
        );
      } catch {
        return [];
      }
    })
  );

  const byId = new Map();

  for (const batch of pages) {
    for (const event of batch) {
      const id = String(event.id ?? event.slug ?? "");
      if (id) byId.set(id, event);
    }
  }

  const excluded =
    /exact score|top batter|more markets|top scorer|toss|completed match|total runs|handicap|spread|ballon d'or|mvp|qualify|outright|team top|player props/i;

  let events = [...byId.values()].filter(event => {
    if (event.closed === true || event.active === false) return false;

    const title = String(event.title ?? event.name ?? "");

    if (!(/\bvs\.?\s+/i.test(title) || /\bversus\b/i.test(title))) {
      return false;
    }

    if (excluded.test(title)) return false;

    const start = Date.parse(event.startDate ?? event.startTime ?? "");

    // Include upcoming events and potentially live matches.
    if (Number.isFinite(start) && start < now - 12 * 60 * 60 * 1000) {
      return false;
    }

    return true;
  });

  if (sportFilter && sportFilter.toLowerCase() !== "all") {
    const wanted = sportFilter.toLowerCase();

    events = events.filter(event => {
      const sport = eventSport(event).toLowerCase();

      if (wanted === "football" || wanted === "soccer") {
        return sport === "football";
      }

      if (wanted === "mma" || wanted === "ufc") {
        return sport === "mma";
      }

      return sport === wanted;
    });
  }

  events.sort((a, b) => {
    const aStart = Date.parse(a.startDate ?? a.startTime ?? "");
    const bStart = Date.parse(b.startDate ?? b.startTime ?? "");

    const aTime = Number.isFinite(aStart) ? aStart : Number.MAX_SAFE_INTEGER;
    const bTime = Number.isFinite(bStart) ? bStart : Number.MAX_SAFE_INTEGER;

    return aTime - bTime;
  });

  const total = events.length;
  const page = events.slice(offset, offset + limit);
  const data = [];

  for (const event of page) {
    const markets = arr(event.markets);

    const winnerMarket = markets.find(original => {
      const market = normalizeMarket(original);
      const outcomes = market.outcomes.map(value =>
        String(value).trim().toLowerCase()
      );

      return (
        market.clobTokenIds.length >= 2 &&
        outcomes.length >= 2 &&
        !(outcomes.length === 2 &&
          outcomes.includes("yes") &&
          outcomes.includes("no")) &&
        !/exact score|top batter|toss|total runs|handicap|spread/i.test(
          market.question
        )
      );
    });

    const selectedEvent = winnerMarket
      ? { ...event, markets: [winnerMarket] }
      : { ...event, markets: [] };

    data.push(await addQuotes(selectedEvent));
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
    quoteNote:
      "Decimal conversions are indicative. Missing public CLOB quotes remain null.",
    updatedAt: new Date().toISOString(),
    data
  };
}

function collectionParams(requestUrl, resource) {
  const input = new URL(requestUrl);
  const params = new URLSearchParams();

  for (const [key, value] of input.searchParams.entries()) {
    if (key === "type" || key === "sport") continue;
    params.set(key, value);
  }

  if (!params.has("limit")) params.set("limit", "50");
  if (!params.has("offset")) params.set("offset", "0");

  // Default collection listings to active events/markets.
  if (!params.has("id") && !params.has("slug")) {
    if (!params.has("active")) params.set("active", "true");
    if (!params.has("closed")) params.set("closed", "false");
  }

  return `${GAMMA}/${resource}?${params.toString()}`;
}

async function getCollection(requestUrl, resource) {
  const input = new URL(requestUrl);
  const limit = intParam(input.searchParams.get("limit"), 50, 100);
  const offset = intParam(input.searchParams.get("offset"), 0, 1000000);

  const result = await getJSON(collectionParams(requestUrl, resource));
  const items = Array.isArray(result) ? result : result ? [result] : [];

  let data;

  if (resource === "events") {
    data = items.map(normalizeEvent);
  } else {
    data = items.map(normalizeMarket);
  }

  return {
    success: true,
    provider: "Polymarket Gamma",
    type: resource,
    limit,
    offset,
    count: data.length,
    data,
    updatedAt: new Date().toISOString()
  };
}

async function getOne(requestUrl, resource) {
  const input = new URL(requestUrl);
  const id = input.searchParams.get("id");
  const slug = input.searchParams.get("slug");

  if (!id && !slug) {
    return {
      error: true,
      message: `Provide an id or slug, e.g. /${resource === "events" ? "event" : "market"}?id=...`
    };
  }

  const params = new URLSearchParams();
  if (id) params.set("id", id);
  if (slug) params.set("slug", slug);

  const result = await getJSON(`${GAMMA}/${resource}?${params.toString()}`);
  const item = Array.isArray(result) ? result[0] : result;

  if (!item) return null;

  if (resource === "events") {
    return addQuotes(item);
  }

  return addMarketQuotes(item);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

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
          data: Array.isArray(data) ? data : [],
          updatedAt: new Date().toISOString()
        });
      }

      if (path === "/matches") {
        const limit = intParam(url.searchParams.get("limit"), 50, 100);
        const offset = intParam(
          url.searchParams.get("offset"),
          0,
          1000000
        );
        const sport = url.searchParams.get("sport") ?? "all";

        return json(await getMatches(limit, offset, sport));
      }

      if (path === "/events") {
        return json(await getCollection(request.url, "events"));
      }

      if (path === "/markets") {
        return json(await getCollection(request.url, "markets"));
      }

      if (path === "/polymarket") {
        const type = (
          url.searchParams.get("type") ?? "events"
        ).toLowerCase();

        if (type === "events" || type === "event") {
          return json(await getCollection(request.url, "events"));
        }

        if (type === "markets" || type === "market") {
          return json(await getCollection(request.url, "markets"));
        }

        return json({
          success: false,
          error: "Unsupported type. Use type=events or type=markets."
        }, 400);
      }

      if (path === "/event") {
        const event = await getOne(request.url, "events");

        if (!event) {
          return json({ success: false, error: "Event not found" }, 404);
        }

        return json({
          success: true,
          provider: "Polymarket Gamma + public CLOB",
          data: event,
          updatedAt: new Date().toISOString()
        });
      }

      if (path === "/market") {
        const market = await getOne(request.url, "markets");

        if (!market) {
          return json({ success: false, error: "Market not found" }, 404);
        }

        return json({
          success: true,
          provider: "Polymarket Gamma + public CLOB",
          data: market,
          updatedAt: new Date().toISOString()
        });
      }

      return json({
        success: false,
        error: "Endpoint not found",
        available: ["/health", "/sports", "/matches", "/polymarket", "/events", "/markets", "/event", "/market"]
      }, 404);

    } catch (error) {
      return json({
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
        endpoint: path,
        updatedAt: new Date().toISOString()
      }, 502);
    }
  }
};
