
export default {
  async fetch(request) {
    const url = new URL(request.url); 
    const origin = request.headers.get("Origin") || "*";

    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    };

    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });

    if (request.method !== "GET")
      return reply({ success: false, error: "Method not allowed" }, 405);

    const getJSON = async (target) => {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(12000),
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(`Provider HTTP ${response.status}`);
      return data;
    };

    const gamma = (path, params = {}) => {
      const target = new URL(
        `https://gamma-api.polymarket.com${path}`
      );
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          target.searchParams.set(key, String(value));
        }
      }
      return target.toString();
    };

    const intParam = (name, fallback, min, max) => {
      const n = Number.parseInt(url.searchParams.get(name) || "", 10);
      return Number.isFinite(n)
        ? Math.min(max, Math.max(min, n))
        : fallback;
    };

    const parseArray = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value !== "string") return [];
      try {
        const result = JSON.parse(value);
        return Array.isArray(result) ? result : [];
      } catch {
        return [];
      }
    };

    const num = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const normalizeMarket = (market) => {
      const outcomes = parseArray(market.outcomes);
      const tokenIds = parseArray(market.clobTokenIds);

      return {
        id: market.id ?? null,
        conditionId: market.conditionId ?? null,
        question: market.question ?? market.groupItemTitle ?? "",
        slug: market.slug ?? null,
        active: market.active ?? null,
        closed: market.closed ?? null,
        endDate: market.endDate ?? null,
        volume: num(market.volumeNum ?? market.volume),
        liquidity: num(market.liquidityNum ?? market.liquidity),
        outcomes: outcomes.map((name, i) => ({
          name: String(name),
          tokenId: tokenIds[i] ?? null
        }))
      };
    };

    const getQuotes = async (tokenId) => {
      const empty = {
        bestBid: null,
        bestAsk: null,
        backDecimal: null,
        layDecimal: null,
        bidDepth: null,
        askDepth: null
      };

      if (!tokenId) return empty;

      try {
        const book = await getJSON(
          "https://clob.polymarket.com/book?token_id=" +
          encodeURIComponent(tokenId)
        );

        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];

        const bidPrices = bids
          .map(x => num(x.price))
          .filter(x => x !== null && x > 0);

        const askPrices = asks
          .map(x => num(x.price))
          .filter(x => x !== null && x > 0);

        const bestBid = bidPrices.length
          ? Math.max(...bidPrices)
          : null;

        const bestAsk = askPrices.length
          ? Math.min(...askPrices)
          : null;

        return {
          bestBid,
          bestAsk,
          backDecimal:
            bestAsk !== null && bestAsk < 1
              ? Number((1 / bestAsk).toFixed(4))
              : null,
          layDecimal:
            bestBid !== null && bestBid < 1
              ? Number((1 / bestBid).toFixed(4))
              : null,
          bidDepth: bids.reduce(
            (sum, x) => sum + (num(x.size) || 0), 0
          ),
          askDepth: asks.reduce(
            (sum, x) => sum + (num(x.size) || 0), 0
          )
        };
      } catch {
        return empty;
      }
    };

    const addQuotes = async (market) => {
      const normalized = normalizeMarket(market);
      return {
        ...normalized,
        outcomes: await Promise.all(
          normalized.outcomes.map(async outcome => ({
            ...outcome,
            ...(await getQuotes(outcome.tokenId))
          }))
        )
      };
    };

    try {
      // Health check
      if (url.pathname === "/" || url.pathname === "/health") {
        return reply({
          success: true,
          status: "ok",
          worker: "crystal-odds-api",
          provider: "Polymarket Gamma + CLOB",
          endpoints: [
            "/health",
            "/sports",
            "/polymarket?type=events&limit=100&offset=0",
            "/polymarket?type=markets&limit=100&offset=0",
            "/events?limit=100&offset=0",
            "/markets?limit=100&offset=0",
            "/event?id=EVENT_ID",
            "/event?slug=EVENT_SLUG",
            "/market?id=MARKET_ID",
            "/market?slug=MARKET_SLUG"
          ],
          updatedAt: new Date().toISOString()
        });
      }

      // Event tags for available sport/category filters
      if (url.pathname === "/sports") {
        const raw = await getJSON(gamma("/events", {
          active: true,
          closed: false,
          limit: 100,
          offset: 0,
          order: "volume",
          ascending: false
        }));

        const counts = new Map();

        for (const event of (Array.isArray(raw) ? raw : [])) {
          for (const tag of (Array.isArray(event.tags) ? event.tags : [])) {
            const label = String(tag.label || tag.name || "").trim();
            if (label) {
              counts.set(label, (counts.get(label) || 0) + 1);
            }
          }
        }

        return reply({
          success: true,
          provider: "Polymarket Gamma",
          updatedAt: new Date().toISOString(),
          sports: [...counts.entries()]
            .map(([name, eventCount]) => ({ name, eventCount }))
            .sort((a, b) => b.eventCount - a.eventCount)
        });
      }

      // Event and market lists with pagination and search
      if (["/polymarket", "/events", "/markets"].includes(url.pathname)) {
        const type = url.searchParams.get("type") ||
          (url.pathname === "/markets" ? "markets" : "events");

        if (!["events", "markets"].includes(type)) {
          return reply({
            success: false,
            error: "type must be events or markets"
          }, 400);
        }

        const limit = intParam("limit", 100, 1, 100);
        const offset = intParam("offset", 0, 0, 1000000);

        const raw = await getJSON(gamma(`/${type}`, {
          active: url.searchParams.get("active") ?? "true",
          closed: url.searchParams.get("closed") ?? "false",
          limit,
          offset,
          order: type === "events" ? "volume" : "volume24hr",
          ascending: false,
          tag_id: url.searchParams.get("tag_id")
        }));

        let items = Array.isArray(raw) ? raw : [];
        const search = (
          url.searchParams.get("search") || ""
        ).trim().toLowerCase();

        if (search) {
          items = items.filter(item => {
            const marketQuestions = Array.isArray(item.markets)
              ? item.markets.map(m => m.question)
              : [];

            const text = [
              item.title,
              item.name,
              item.slug,
              item.question,
              ...marketQuestions
            ].filter(Boolean).join(" ").toLowerCase();

            return text.includes(search);
          });
        }

        let data;

        if (type === "events") {
          data = items.map(event => {
            const markets = (
                if (type === "events") {
          data = items.map(event => {
            const markets = (
              Array.isArray(event.markets) ? event.markets : []
            ).map(normalizeMarket);
   
            return {
              id: event.id ?? null,
              title: event.title ?? event.name ?? "",
              slug: event.slug ?? null,
              description: event.description ?? "",
              startDate: event.startDate ?? event.startTime ?? null,
              endDate: event.endDate ?? null,
              active: event.active ?? null,
              closed: event.closed ?? null,
              volume: num(event.volume ?? event.volumeNum),
              liquidity: num(event.liquidity ?? event.liquidityNum),
              tags: Array.isArray(event.tags)
                ? event.tags.map(t => ({
                    id: t.id ?? null,
                    label: t.label ?? t.name ?? ""
                  }))
                : [],
              marketCount: markets.length,
              markets,
              marketQuestions: markets
                .map(m => m.question)
                .filter(Boolean)
            };
          });
        } else {
          data = items.map(normalizeMarket);
        }

              marketCount: markets.length,
              markets,
              marketQuestions: markets
                .map(m => m.question)
                .filter(Boolean)
            };
          });
        } else {
          data = items.map(normalizeMarket);
        }

        return reply({
          success: true,
          provider: "Polymarket Gamma",
          type,
          limit,
          offset,
          count: data.length,
          updatedAt: new Date().toISOString(),
          data
        });
      }
// Live and upcoming real-match endpoint

if (url.pathname === "/matches") {
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 50)
  );
  const offset = Math.max(
    0,
    Number(url.searchParams.get("offset")) || 0
  );
  const sport = (url.searchParams.get("sport") || "").toLowerCase();
  const search = (url.searchParams.get("search") || "").toLowerCase();

  const pageSize = 100;
  const pageCount = 10;

  const pages = await Promise.all(
    Array.from({ length: pageCount }, async (_, page) => {
      try {
        const apiUrl = new URL("https://gamma-api.polymarket.com/events");
        apiUrl.searchParams.set("active", "true");
        apiUrl.searchParams.set("closed", "false");
        apiUrl.searchParams.set("limit", String(pageSize));
        apiUrl.searchParams.set("offset", String(page * pageSize));
        apiUrl.searchParams.set("order", "volume_24hr");
        apiUrl.searchParams.set("ascending", "false");

        const response = await fetch(apiUrl.toString(), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12000)
        });

        if (!response.ok) return [];

        const data = await response.json();
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    })
  );

  const events = new Map();

  for (const page of pages) {
    for (const event of page) {
      if (event && event.id != null) {
        events.set(String(event.id), event);
      }
    }
  }

  const excluded = [
    "presidential nominee",
    "ballon d'or",
    "winner of",
    "champion of the",
    "season winner",
    "league winner",
    "to win the",
    "outright"
  ];

  const isMatchTitle = (title) =>
    /\s(?:vs\.?|versus|v\.|@)\s/i.test(title || "");

  const matches = [...events.values()]
    .filter((event) => {
      const title = String(event.title || event.name || "").trim();
      const lower = title.toLowerCase();

      if (!title || event.closed === true || event.active === false) {
        return false;
      }

      if (!isMatchTitle(title)) return false;
      if (excluded.some((word) => lower.includes(word))) return false;

      if (search && !lower.includes(search)) return false;

      if (sport) {
        const sportText = [
          event.sport,
          event.category,
          event.league,
          event.series?.name,
          event.slug,
          title
        ].filter(Boolean).join(" ").toLowerCase();
// One event with actual order-book quotes 
        
if (url.pathname === "/matches") {
  const limit = Math.min(100, Math.max(1,
    Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0,
    Number(url.searchParams.get("offset")) || 0);
  const sportFilter = (url.searchParams.get("sport") || "")
    .toLowerCase().trim();
  const search = (url.searchParams.get("search") || "")
    .toLowerCase().trim();

  const now = Date.now();
  const liveWindow = 6 * 60 * 60 * 1000;
  const diagnostics = {
    sportsLoaded: 0,
    seriesChecked: 0,
    seriesSucceeded: 0,
    eventsScanned: 0,
    skippedOld: 0,
    errors: []
  };

  const fetchJSON = async (endpoint) => {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  };

  try {
    const sportsData = await fetchJSON(
      "https://gamma-api.polymarket.com/sports"
    );

    const sports = Array.isArray(sportsData) ? sportsData : [];
    diagnostics.sportsLoaded = sports.length;

    let seriesList = sports
      .filter(s => s.series && /^\d+$/.test(String(s.series)))
      .filter(s => {
        if (!sportFilter) return true;
        return [
          s.sport, s.name, s.league
        ].filter(Boolean).join(" ").toLowerCase()
          .includes(sportFilter);
      });

    seriesList.sort((a, b) =>
      String(b.createdAt || "").localeCompare(
        String(a.createdAt || "")
      )
    );

    // Keep within a conservative per-request subrequest budget.
    seriesList = seriesList.slice(0, 40);
    diagnostics.seriesChecked = seriesList.length;

    const eventMap = new Map();

    for (let i = 0; i < seriesList.length; i += 10) {
      const batch = seriesList.slice(i, i + 10);

      const results = await Promise.all(batch.map(async s => {
        try {
          const endpoint = new URL(
            "https://gamma-api.polymarket.com/events"
          );
          endpoint.searchParams.set("series_id", String(s.series));
          endpoint.searchParams.set("active", "true");
          endpoint.searchParams.set("closed", "false");
          endpoint.searchParams.set("limit", "50");
          endpoint.searchParams.set("offset", "0");

          const data = await fetchJSON(endpoint.toString());
          diagnostics.seriesSucceeded++;

          return (Array.isArray(data) ? data : []).map(event => ({
            ...event,
            _sportName: s.name || s.sport || null,
            _sportCode: s.sport || null,
            _seriesId: String(s.series)
          }));
        } catch (error) {
          if (diagnostics.errors.length < 5) {
            diagnostics.errors.push(
              String(s.sport || s.series) + ": " +
              String(error.message || error)
            );
          }
          return [];
        }
      }));

      for (const list of results) {
        for (const event of list) {
          if (event && event.id != null) {
            eventMap.set(String(event.id), event);
          }
        }
      }
    }

    diagnostics.eventsScanned = eventMap.size;

    const grouped = new Map();

    for (const event of eventMap.values()) {
      const title = String(event.title || event.name || "").trim();

      if (!title || event.closed === true || event.active === false) {
        continue;
      }

      if (!/\s(?:vs\.?|versus|v\.|@)\s/i.test(title)) continue;

      if (/\b(winner|champion|qualify|nominee|outright)\b/i.test(title)) {
        continue;
      }

      const gameTime = Date.parse(
        event.gameStartTime || event.startTime || ""
      );

      // Do not treat old fixtures as live just because an event is active.
      if (!Number.isFinite(gameTime) ||
          gameTime < now - liveWindow) {
        diagnostics.skippedOld++;
        continue;
      }

      const marketList = Array.isArray(event.markets)
        ? event.markets
        : [];

      const openMarkets = marketList.filter(m =>
        m &&
        m.active !== false &&
        m.closed !== true &&
        m.acceptingOrders !== false
      );

      if (!openMarkets.length) continue;

      const baseTitle = title.split(/\s+-\s+/)[0].trim();
      const key = baseTitle.toLowerCase() + "|" +
        new Date(gameTime).toISOString();

      if (search && !baseTitle.toLowerCase().includes(search)) {
        continue;
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          id: event.parentEventId || event.id,
          title: baseTitle,
          slug: event.slug || null,
          sport: event._sportName,
          sportCode: event._sportCode,
          seriesId: event._seriesId,
          gameStartTime: event.gameStartTime || null,
          startDate: event.startDate || null,
          status: gameTime <= now ? "live" : "upcoming",
          markets: [],
          marketEventIds: []
        });
      }

      const match = grouped.get(key);
      match.marketEventIds.push(event.id);

      for (const market of openMarkets) {
        match.markets.push(market);
      }
    }

    const matches = [...grouped.values()].sort((a, b) =>
      (Date.parse(a.gameStartTime || "") || 0) -
      (Date.parse(b.gameStartTime || "") || 0)
    );

    return reply({
      success: true,
      provider: "Polymarket Gamma sports series",
      type: "matches",
      limit,
      offset,
      scanned: diagnostics.eventsScanned,
      count: matches.length,
      diagnostics,
      updatedAt: new Date().toISOString(),
      data: matches.slice(offset, offset + limit)
    });
  } catch (error) {
    return reply({
      success: false,
      provider: "Polymarket Gamma sports series",
      error: String(error.message || error),
      diagnostics,
      updatedAt: new Date().toISOString(),
      data: []
    }, 502);
  }
}

        
