export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);
const origin = request.headers.get("Origin") || "*";

const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin"
};
const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers
  });
if (request.method === "OPTIONS") {
  return new Response(null, {
    status: 204,
    headers
  });
}
if (request.method !== "GET") {
  return reply({ error: "Method not allowed" }, 405);
}
if (url.pathname === "/health") {
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
if (url.pathname !== "/sports" && url.pathname !== "/odds") {
  return reply({
    error: "Endpoint not found",
    endpoints: ["/health", "/sports", "/odds?sport=YOUR_SPORT_KEY"]
  }, 404);
}
if (!env.ODDS_API_KEY) {
  return reply({
    error: "ODDS_API_KEY secret is missing",
    message: "Add ODDS_API_KEY in Cloudflare Worker secrets."
  }, 500);
}
let apiUrl;
let cacheSeconds;
if (url.pathname === "/sports") {
  apiUrl = new URL(
    "https://api.the-odds-api.com/v4/sports/"
  );
  apiUrl.searchParams.set("apiKey", env.ODDS_API_KEY);
  cacheSeconds = 300;
} else {
  const sport = url.searchParams.get("sport");
  if (!sport) {
    return reply({
      error: "Missing sport parameter",
      example: "/odds?sport=basketball_nba"
    }, 400);
  }
  apiUrl = new URL(
    `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/`
  );
  apiUrl.searchParams.set("apiKey", env.ODDS_API_KEY);
  apiUrl.searchParams.set(
    "regions",
    url.searchParams.get("regions") || "uk,us"
  );
  apiUrl.searchParams.set(
    "markets",
    url.searchParams.get("markets") || "h2h,spreads,totals"
  );
  apiUrl.searchParams.set(
    "oddsFormat",
    url.searchParams.get("oddsFormat") || "decimal"
  );
  apiUrl.searchParams.set(
    "dateFormat",
    url.searchParams.get("dateFormat") || "iso"
  );
  cacheSeconds = 15;
}
try {
  const cache = caches.default;
  const cacheKey = new Request(apiUrl.toString(), {
    method: "GET"
  });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const responseHeaders = new Headers(cached.headers);
    responseHeaders.set(
      "Access-Control-Allow-Origin",
      origin
    );
    responseHeaders.set("Vary", "Origin");
    responseHeaders.set("X-Cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      headers: responseHeaders
    });
  }
  const response = await fetch(apiUrl.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return reply({
      error: "Odds provider request failed",
      providerStatus: response.status,
      details: data
    }, 502);
  }
  const successResponse = new Response(
    JSON.stringify(data),
    {
      status: 200,
      headers: {
        ...headers,
        "Cache-Control": `public, max-age=${cacheSeconds}`,
        "X-Cache": "MISS"
      }
    }
  );
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(successResponse.clone().body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${cacheSeconds}`
        }
      })
    )
  );
  return successResponse;
} catch (error) {
  return reply({
    error: "Could not connect to the odds provider",
    message: error?.name === "TimeoutError"
      ? "Odds provider request timed out"
      : "Please try again shortly"
  }, 502);
}

}
};
