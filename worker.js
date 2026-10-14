
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS
      });
    }

    if (request.method !== "GET") {
      return reply({
        error: "Only GET requests are supported"
      }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return reply({
        status: "ok",
        worker: "crystal-odds-api",
        apiKeyConfigured: Boolean(env.ODDS_API_KEY),
        endpoints: [
          "/health",
          "/sports",
          "/odds?sport=YOUR_SPORT_KEY"
        ]
      });
    }

    if (!env.ODDS_API_KEY) {
      return reply({
        error: "Missing ODDS_API_KEY secret",
        instruction:
          "Add ODDS_API_KEY under Worker Settings > Variables and Secrets, then deploy."
      }, 500);
    }

    let apiPath;

    if (path === "/sports") {
      apiPath = "sports/";
    } else if (path === "/odds") {
      const sport = url.searchParams.get("sport");

      if (!sport || !/^[a-zA-Z0-9_]+$/.test(sport)) {
        return reply({
          error: "Provide a valid sport key",
          example: "/odds?sport=YOUR_SPORT_KEY",
          instruction: "Open /sports to find available sport keys."
        }, 400);
      }

      const regions = url.searchParams.get("regions") || "uk";
      const markets = url.searchParams.get("markets") || "h2h";

      if (!/^[a-z,]+$/.test(regions) ||
          !/^[a-z_,]+$/.test(markets)) {
        return reply({
          error: "Invalid regions or markets"
        }, 400);
      }

      apiPath =
        "sports/" + encodeURIComponent(sport) + "/odds/?" +
        "regions=" + encodeURIComponent(regions) +
        "&markets=" + encodeURIComponent(markets) +
        "&oddsFormat=decimal&dateFormat=iso";
    } else {
      return reply({
        error: "Route not found",
        available: [
          "/health",
          "/sports",
          "/odds?sport=YOUR_SPORT_KEY"
        ]
      }, 404);
    }

    const apiUrl = new URL(
      "https://api.the-odds-api.com/v4/" + apiPath
    );

    apiUrl.searchParams.set("apiKey", env.ODDS_API_KEY);

    try {
      const response = await fetch(apiUrl.toString(), {
        headers: {
          Accept: "application/json"
        }
      });

      const body = await response.text();
      let data;

      try {
        data = JSON.parse(body);
      } catch {
        data = {
          error: "Invalid response from odds provider"
        };
      }

      if (!response.ok) {
        return reply({
          error: "Odds provider request failed",
          providerStatus: response.status,
          details: data,
          credits: {
            remaining: response.headers.get(
              "x-requests-remaining"
            ),
            used: response.headers.get(
              "x-requests-used"
            ),
            lastCost: response.headers.get(
              "x-requests-last"
            )
          }
        }, 502);
      }

      return reply({
        success: true,
        data: data,
        credits: {
          remaining: response.headers.get(
            "x-requests-remaining"
          ),
          used: response.headers.get(
            "x-requests-used"
          ),
          lastCost: response.headers.get(
            "x-requests-last"
          )
        }
      });
    } catch {
      return reply({
        error: "Could not connect to the odds provider"
      }, 502);
    }
  }
};
