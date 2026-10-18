
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
        const limit = intParam("limit", 100, 1, 100);
        const offset = intParam("offset", 0, 0, 1000000);
        const search = (url.searchParams.get("search") || "")
          .trim()
          .toLowerCase();
        const sport = (url.searchParams.get("sport") || "")
          .trim()
          .toLowerCase();

        const raw = await getJSON(gamma("/events", {
          active: true,
          closed: false,
          limit,
          offset,
          order: "startDate",
          ascending: true
        }));

        const now = Date.now();

        const data = (Array.isArray(raw) ? raw : [])
          .filter(event => {
            if (event.closed === true || event.active === false) {
              return false;
            }

            const title = String(
              event.title || event.name || event.question || ""
            ).trim();

            if (!title) return false;

            // Remove outrights, tournaments and winner futures
            if (/\b(outright|ballon d['’]or|league winner|tournament winner|season winner|champion\s+20\d{2}|winner\s+20\d{2}|to win the league)\b/i.test(title)) {
              return false;
            }

            // Require two identifiable participants in the title
            const parts = title.split(/\s+(?:vs\.?|v\.?|versus|@)\s+/i);
            if (parts.length !== 2) return false;

            const home = parts[0].trim();
            const away = parts[1].trim();

            if (!home || !away || home.toLowerCase() === away.toLowerCase()) {
              return false;
            }

            const startValue = event.startDate || event.startTime || null;
            const endValue = event.endDate || null;
            const start = startValue ? Date.parse(startValue) : NaN;
            const end = endValue ? Date.parse(endValue) : NaN;

            const statusText = [
              event.status,
              event.eventStatus,
              event.gameStatus
            ].filter(Boolean).join(" ").toLowerCase();

            const explicitlyLive =
              event.live === true ||
              event.isLive === true ||
              /\b(live|in progress|in-play|in play)\b/.test(statusText);

            const explicitlyEnded =
              event.ended === true ||
              event.isEnded === true ||
              /\b(ended|finished|completed|final)\b/.test(statusText);

            if (explicitlyEnded) return false;

            const upcoming = Number.isFinite(start) && start > now;
            const withinEndTime =
              Number.isFinite(end) && end >= now;

            // Include upcoming fixtures or events with live evidence.
            // A past start date alone is not proof that a match is live.
            if (!explicitlyLive && !upcoming && !withinEndTime) {
              return false;
            }

            if (sport) {
              const tags = Array.isArray(event.tags) ? event.tags : [];
              const tagText = tags.map(t =>
                String(t.label || t.name || "")
              ).join(" ").toLowerCase();

              if (
                !tagText.includes(sport) &&
                !title.toLowerCase().includes(sport)
              ) {
                return false;
              }
            }

            if (
              search &&
              !title.toLowerCase().includes(search)
            ) {
              return false;
            }

            return true;
          })
          .map(event => {
            const startValue = event.startDate || event.startTime || null;
            const endValue = event.endDate || null;
            const start = startValue ? Date.parse(startValue) : NaN;
            const end = endValue ? Date.parse(endValue) : NaN;

            const statusText = [
              event.status,
              event.eventStatus,
              event.gameStatus
            ].filter(Boolean).join(" ").toLowerCase();

            const live =
              event.live === true ||
              event.isLive === true ||
              /\b(live|in progress|in-play|in play)\b/.test(statusText);

            const upcoming = Number.isFinite(start) && start > now;

            const markets = (
              Array.isArray(event.markets) ? event.markets : []
            ).map(normalizeMarket);

            return {
              id: event.id ?? null,
              title: event.title ?? event.name ?? "",
              slug: event.slug ?? null,
              description: event.description ?? "",
              startDate: startValue,
              endDate: endValue,
              active: event.active ?? null,
              closed: event.closed ?? null,
              status: live ? "live" : "upcoming",
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
          })
          .sort((a, b) => {
            if (a.status === "live" && b.status !== "live") return -1;
            if (b.status === "live" && a.status !== "live") return 1;
            return (Date.parse(a.startDate || "") || 0) -
                   (Date.parse(b.startDate || "") || 0);
          });

        return reply({
          success: true,
          provider: "Polymarket Gamma",
          type: "matches",
          limit,
          offset,
          count: data.length,
          updatedAt: new Date().toISOString(),
          data
        });
      }

      // One event with actual order-book quotes
      if (url.pathname === "/event") {
        const id = url.searchParams.get("id");
        const slug = url.searchParams.get("slug");

        if (!id && !slug) {
          return reply({
            success: false,
            error: "Provide event id or slug"
          }, 400);
        }

        const raw = await getJSON(
          id
            ? gamma(`/events/${encodeURIComponent(id)}`)
            : gamma("/events", { slug })
        );

        const event = Array.isArray(raw) ? raw[0] : raw;

        if (!event) {
          return reply({
            success: false,
            error: "Event not found"
          }, 404);
        }

        const markets = Array.isArray(event.markets)
          ? event.markets
          : [];

        return reply({
          success: true,
          provider: "Polymarket Gamma + CLOB",
          updatedAt: new Date().toISOString(),
          data: {
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
            tags: event.tags ?? [],
            markets: await Promise.all(markets.map(addQuotes))
          }
        });
      }

      // One market with actual order-book quotes
      if (url.pathname === "/market") {
        const id = url.searchParams.get("id");
        const slug = url.searchParams.get("slug");

        if (!id && !slug) {
          return reply({
            success: false,
            error: "Provide market id or slug"
          }, 400);
        }

        const raw = await getJSON(
          id
            ? gamma(`/markets/${encodeURIComponent(id)}`)
            : gamma("/markets", { slug })
        );

        const market = Array.isArray(raw) ? raw[0] : raw;

        if (!market) {
          return reply({
            success: false,
            error: "Market not found"
          }, 404);
        }

        return reply({
          success: true,
          provider: "Polymarket Gamma + CLOB",
          updatedAt: new Date().toISOString(),
          data: await addQuotes(market)
        });
      }

      return reply({
        success: false,
        error: "Endpoint not found",
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
        ]
      }, 404);

    } catch (error) {
      return reply({
        success: false,
        error: "Provider request failed",
        message: error?.message || "Unknown error",
        updatedAt: new Date().toISOString()
      }, 502);
    }
  }
};
