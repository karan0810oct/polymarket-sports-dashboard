
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
  const now = Date.now();

  // Fetch only active, non-closed Polymarket events.
  const pages = await Promise.all(
    [0, 100, 200].map(async pageOffset => {
      const url =
        `${GAMMA}/events?active=true&closed=false` +
        `&order=id&ascending=false&limit=100&offset=${pageOffset}`;

      try {
        const data = await getJSON(url);
        return Array.isArray(data) ? data : [];
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

    const startText = event.startDate ?? event.startTime ?? "";
    const start = Date.parse(startText);

    // Keep upcoming matches and matches that may still be live.
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
        return sport.includes("football") || sport.includes("soccer");
      }

      if (wanted === "mma" || wanted === "ufc") {
        return sport.includes("mma") || sport.includes("ufc");
      }

      return sport.includes(wanted);
    });
  }

  events.sort((a, b) => {
    const aStart = Date.parse(a.startDate ?? a.startTime ?? "");
    const bStart = Date.parse(b.startDate ?? b.startTime ?? "");

    // Upcoming games first; events without a date go last.
    const aTime = Number.isFinite(aStart) ? aStart : Number.MAX_SAFE_INTEGER;
    const bTime = Number.isFinite(bStart) ? bStart : Number.MAX_SAFE_INTEGER;

    return aTime - bTime;
  });

  const total = events.length;
  const page = events.slice(offset, offset + limit);

  const data = [];
  for (const event of page) {
    const markets = arr(event.markets);

    // Prefer the actual match-winner market, not Yes/No side markets.
    const winnerMarket = markets.find(original => {
      const market = normalizeMarket(original);
      const outcomes = market.outcomes.map(value =>
        String(value).trim().toLowerCase()
      );

      return (
        market.clobTokenIds.length >= 2 &&
        outcomes.length >= 2 &&
        !(
          outcomes.length === 2 &&
          outcomes.includes("yes") &&
          outcomes.includes("no")
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
      "Decimal odds are shown only when public CLOB quotes are available. Missing quotes remain null.",
    updatedAt: new Date().toISOString(),
    data
  };
}
