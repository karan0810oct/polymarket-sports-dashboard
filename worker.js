export default {
  async fetch(request, env) {
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
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET") {
      return reply({ error: "Method not allowed" }, 405);
    }
    const getJSON = async (target, options = {}) => {
      const response = await fetch(target, {
        ...options,
        signal: AbortSignal.timeout(12000)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error("Provider HTTP " + response.status);
      }
      return data;
    };
    if (url.pathname === "/health") {
      return reply({
        status: "ok",
        worker: "crystal-odds-api",
        providers: {
          polymarket: true,
          parlay: Boolean(env.PARLAY_API_KEY)
        },
        endpoints: [
          "/health",
          "/polymarket?limit=50",
          "/parlay?sport=basketball_nba"
        ]
      });
    }
    try {
      if (url.pathname === "/polymarket") {
        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit")) || 50)
        );
        const target = new URL(
          "https://gamma-api.polymarket.com/markets"
        );
        target.searchParams.set("active", "true");
        target.searchParams.set("closed", "false");
        target.searchParams.set("limit", String(limit));
        target.searchParams.set("order", "volume24hr");
        target.searchParams.set("ascending", "false");
        const markets = await getJSON(target.toString());
        const data = await Promise.all(
          (Array.isArray(markets) ? markets : []).map(async market => {
            let tokens = [];
            try {
              const ids = JSON.parse(market.clobTokenIds || "[]");
              const outcomes = JSON.parse(market.outcomes || "[]");
              tokens = await Promise.all(
                ids.map(async (tokenId, i) => {
                  const book = await getJSON(
                    "https://clob.polymarket.com/book?token_id=" +
                    encodeURIComponent(tokenId)
                  );
                  const bids = Array.isArray(book.bids) ? book.bids : [];
                  const asks = Array.isArray(book.asks) ? book.asks : [];
                  const bestBid = bids.length
                    ? Math.max(...bids.map(x => Number(x.price)))
                    : null;
                  const bestAsk = asks.length
                    ? Math.min(...asks.map(x => Number(x.price)))
                    : null;
                  return {
                    outcome: outcomes[i] || String(i),
                    tokenId,
                    bestBid,
                    bestAsk,
                    backDecimal: bestAsk > 0 ? 1 / bestAsk : null,
                    layDecimal: bestBid > 0 ? 1 / bestBid : null
                  };
                })
              );
            } catch (_) {}
            return {
              id: market.id,
              question: market.question,
              slug: market.slug,
              volume: market.volumeNum ?? market.volume ?? null,
              liquidity: market.liquidityNum ?? market.liquidity ?? null,
              outcomes: tokens
            };
          })
        );
        return reply({
          success: true,
          provider: "Polymarket Exchange",
          updatedAt: new Date().toISOString(),
          count: data.length,
          data
        });
      }
      if (url.pathname === "/parlay") {
        if (!env.PARLAY_API_KEY) {
          return reply({
            success: false,
            error: "Add PARLAY_API_KEY as a Cloudflare Worker secret"
          }, 500);
        }
        const sport = url.searchParams.get("sport");
        if (!sport) {
          return reply({
            error: "Add a sport parameter, e.g. basketball_nba"
          }, 400);
        }
        const target = new URL(
          "https://parlay-api.com/v1/sports/" +
          encodeURIComponent(sport) + "/odds"
        );
        target.searchParams.set(
          "regions",
          url.searchParams.get("regions") || "uk"
        );
        target.searchParams.set(
          "markets",
          url.searchParams.get("markets") || "h2h"
        );
        target.searchParams.set("oddsFormat", "decimal");
        target.searchParams.set("include_live", "true");
        const data = await getJSON(target.toString(), {
          headers: {
            "X-API-Key": env.PARLAY_API_KEY,
            "Accept": "application/json"
          }
        });
        return reply({
          success: true,
          provider: "ParlayAPI",
          updatedAt: new Date().toISOString(),
          data
        });
      }
      return reply({
        error: "Endpoint not found",
        endpoints: [
          "/health",
          "/polymarket?limit=50",
          "/parlay?sport=basketball_nba"
        ]
      }, 404);
    } catch (error) {
      return reply({
        success: false,
        error: "Provider request failed",
        message: error.message
      }, 502);
    }
  }
};
