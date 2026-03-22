/**
 * k6 load test: Admin publishes a new product
 *
 * User flow exercised:
 *   1. GET  /login?returnUrl=%2FAdmin → extract anti-forgery token
 *   2. POST /login?returnUrl=%2FAdmin → acquire session cookie
 *   3. GET  /Admin/Product/Create     → extract anti-forgery token for product form
 *   4. POST /Admin/Product/Create     → create product with Published=true
 *
 * This path hits the exact instrumented code:
 *   admin.product.create (span)
 *     └─ catalog.product.insert (span + duration histogram)
 *          └─ catalog.cache.invalidation (span)
 *
 * Usage:
 *   k6 run load-test/publish-product.js
 *
 * Environment variables (all optional - sensible defaults for local dev):
 *   BASE_URL        http://localhost:5000   Base URL of the running nopCommerce instance
 *   ADMIN_EMAIL     admin@yourStore.com     Admin account e-mail
 *   ADMIN_PASSWORD  admin                   Admin account password
 *   SCENARIO        ramp                    One of: ramp | spike | soak
 */

import http from "k6/http";
import {check, group, sleep} from "k6";
import {Counter, Rate, Trend} from "k6/metrics";
import {randomIntBetween} from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// Config
const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || "admin@yourStore.com";
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "admin";
const SCENARIO = __ENV.SCENARIO || "ramp";
const ADMIN_CREATE_PATH = "/Admin/Product/Create";
const ADMIN_RETURN_URL = ADMIN_CREATE_PATH;
const LOGIN_URL = `${BASE_URL}/login?returnUrl=${encodeURIComponent(ADMIN_RETURN_URL)}`;

// Custom metrics
const publishedProducts = new Counter("published_products_total");
const loginFailures = new Rate("login_failure_rate");
const publishFailures = new Rate("publish_failure_rate");
const publishDuration = new Trend("publish_e2e_duration_ms", true);

// Scenario definitions
const scenarios = {
  /** Gradual ramp: simulates a real working day (default) */
  ramp: {
    executor: "ramping-vus",
    startVUs: 1,
    gracefulStop: "10s",
    stages: [
      {duration: "30s", target: 3},   // warm-up
      {duration: "60s", target: 8},   // ramp to moderate load
      {duration: "30s", target: 10},  // peak
      {duration: "30s", target: 3},   // cool-down
      {duration: "10s", target: 0},
    ],
  },

  /** Spike: sudden burst, then back to baseline */
  spike: {
    executor: "ramping-vus",
    startVUs: 1,
    gracefulStop: "10s",
    stages: [
      {duration: "20s", target: 1},
      {duration: "10s", target: 30}, // spike
      {duration: "30s", target: 30},
      {duration: "10s", target: 1},
      {duration: "10s", target: 0},
    ],
  },

  /** Soak: low concurrency over a longer period */
  soak: {
    executor: "constant-vus",
    vus: 3,
    duration: "10m",
    gracefulStop: "10s",
  },
};

export const options = {
  scenarios: {main: scenarios[SCENARIO]},

  thresholds: {
    // 95th-percentile HTTP response time < 2 s
    http_req_duration: ["p(95)<2000"],
    // Less than 1 % of requests should fail at the HTTP transport level
    http_req_failed: ["rate<0.01"],
    // Our custom end-to-end publish latency (step 3+4 only) < 3 s at p95
    publish_e2e_duration_ms: ["p(95)<3000"],
    // Admin login failure rate < 1 %
    login_failure_rate: ["rate<0.01"],
    // Product publish failure rate < 2 %
    publish_failure_rate: ["rate<0.02"],
  },

};


// Helpers

/**
 * Extract the value of the hidden __RequestVerificationToken input from HTML.
 * Returns null if not found.
 */
function extractAntiForgeryToken(html) {
  // <input name="__RequestVerificationToken" type="hidden" value="CfD..." />
  const match = html.match(/<input[^>]+name="__RequestVerificationToken"[^>]+value="([^"]+)"/i);

  if (!match) {
    // Try alternate attribute order
    const match2 = html.match(/<input[^>]+value="([^"]+)"[^>]+name="__RequestVerificationToken"/i);
    return match2 ? match2[1] : null;
  }
  return match[1];
}

/**
 * Extract a best-effort validation summary from the returned HTML page.
 * Helpful when nopCommerce redisplays the Create form instead of redirecting.
 */
function extractValidationSummary(html) {
  if (!html) return null;
  const messages = [];

  const summaryRegex = /<div[^>]*validation-summary-errors[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = summaryRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) messages.push(text);
  }

  const fieldRegex = /<span[^>]*field-validation-error[^>]*>([\s\S]*?)<\/span>/gi;
  while ((match = fieldRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) messages.push(text);
  }

  const uniqueMessages = [...new Set(messages)];
  return uniqueMessages.length ? uniqueMessages.join(" | ") : null;
}

/**
 * Extract selected values from a <select> by id/name. Returns all non-empty option values.
 */
function extractSelectOptionValues(html, selectNameOrId) {
  if (!html || !selectNameOrId) return [];

  const escaped = selectNameOrId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`<select[^>]+id="${escaped}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+name="${escaped}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+id='${escaped}'[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+name='${escaped}'[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
  ];

  let match = null;
  for (const regex of regexes) {
    match = html.match(regex);
    if (match && match[1]) break;
  }

  if (!match || !match[1]) return [];

  const optionsHtml = match[1];
  const values = [];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>/gi;
  let optionMatch;
  while ((optionMatch = optionRegex.exec(optionsHtml)) !== null) {
    const value = optionMatch[1]?.trim();
    if (value) values.push(value);
  }

  return values;
}

function extractSelectedOrFirstOptionValue(html, selectNameOrId) {
  if (!html || !selectNameOrId) return "";

  const escaped = selectNameOrId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`<select[^>]+id="${escaped}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+name="${escaped}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+id='${escaped}'[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
    new RegExp(`<select[^>]+name='${escaped}'[^>]*>([\\s\\S]*?)<\\/select>`, "i"),
  ];

  let selectHtml = "";
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match && match[1]) {
      selectHtml = match[1];
      break;
    }
  }

  if (!selectHtml) return "";

  const selectedMatch = selectHtml.match(/<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/i);
  if (selectedMatch && selectedMatch[1]) return selectedMatch[1].trim();

  const firstMatch = selectHtml.match(/<option[^>]*value="([^"]*)"[^>]*>/i);
  return firstMatch && firstMatch[1] ? firstMatch[1].trim() : "";
}

function serializeFormBody(payload) {
  const parts = [];

  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  return parts.join("&");
}

function isLoginPageResponse(resp) {
  return Boolean(
    resp &&
      resp.status === 200 &&
      (resp.url.includes("/login") ||
        resp.body.includes('class="page login-page"') ||
        resp.body.includes('name="Email"') && resp.body.includes('name="Password"'))
  );
}

/**
 * Log in to the nopCommerce admin panel.
 * Returns the cookie jar (shared across the VU session by k6 automatically)
 * or null on failure.
 */
function adminLogin() {
  // Step 1: GET login page to obtain anti-forgery token
  const loginPage = http.get(LOGIN_URL, {
    tags: {name: "GET /login"},
  });

  const tokenOk = check(loginPage, {
    "login page 200": (r) => r.status === 200,
  });
  if (!tokenOk) return null;

  const token = extractAntiForgeryToken(loginPage.body);
  if (!token) {
    console.warn(`[VU ${__VU}] Could not extract anti-forgery token from login page`);
    return null;
  }

  // Step 2: POST credentials
  const loginResp = http.post(
    LOGIN_URL,
    {
      Email: ADMIN_EMAIL,
      Password: ADMIN_PASSWORD,
      RememberMe: "false",
      __RequestVerificationToken: token,
    },
    {
      tags: {name: "POST /login"},
      redirects: 5,
    }
  );

  // Success: login returns a non-login page, typically the Admin dashboard.
  const loginOk =
    loginResp.status === 200 &&
    !loginResp.url.includes("/login") &&
    !loginResp.body.includes("Login was unsuccessful");

  loginFailures.add(!loginOk);

  if (!loginOk) {
    console.warn(`[VU ${__VU}] Login failed: status=${loginResp.status} url=${loginResp.url}`);
  }

  return loginOk;
}

/**
 * Publish one new product through the admin UI.
 * Assumes the VU is already authenticated (cookie jar populated by adminLogin).
 */
function publishProduct(iteration) {
  const productName = `LoadTest-Product-VU${__VU}-I${iteration}-${Date.now()}`;

  // Step 3: GET Create product page for the anti-forgery token
  const t0 = Date.now();
  let createPage = http.get(`${BASE_URL}${ADMIN_CREATE_PATH}`, {
    tags: {name: "GET /Admin/Product/Create"},
  });

  // If the admin session expired or the user was redirected, re-login once and retry.
  if (isLoginPageResponse(createPage)) {
    sessionEstablished = adminLogin();
    if (!sessionEstablished) {
      publishFailures.add(1);
      return false;
    }

    createPage = http.get(`${BASE_URL}${ADMIN_CREATE_PATH}`, {
      tags: {name: "GET /Admin/Product/Create"},
    });
  }

  const pageOk = check(createPage, {
    "create page 200": (r) => r.status === 200 && !isLoginPageResponse(r) && r.url.includes(ADMIN_CREATE_PATH),
  });
  if (!pageOk) {
    publishFailures.add(1);
    return false;
  }

  const token = extractAntiForgeryToken(createPage.body);
  if (!token) {
    console.warn(`[VU ${__VU}] Could not extract anti-forgery token from create page`);
    publishFailures.add(1);
    return false;
  }

  const categoryIds = extractSelectOptionValues(createPage.body, "SelectedCategoryIds");
  const manufacturerIds = extractSelectOptionValues(createPage.body, "SelectedManufacturerIds");
  const discountIds = extractSelectOptionValues(createPage.body, "SelectedDiscountIds");
  const productTypeId = extractSelectedOrFirstOptionValue(createPage.body, "ProductTypeId") || "5";
  const productTemplateId = extractSelectedOrFirstOptionValue(createPage.body, "ProductTemplateId") || "1";
  const taxCategoryId = extractSelectedOrFirstOptionValue(createPage.body, "TaxCategoryId") || "0";

  // Step 4: POST the new product form
  const payload = {
    __RequestVerificationToken: token,
    Name: productName,
    ShortDescription: "",
    FullDescription: "",
    Sku: "",
    ProductTypeId: productTypeId,
    ProductTemplateId: productTemplateId,
    VisibleIndividually: "true",
    Published: "true",
    Price: "0",
    TaxCategoryId: taxCategoryId,
    IsTaxExempt: "false",
    IsShipEnabled: "true",
    Weight: "0",
    Length: "0",
    Width: "0",
    Height: "0",
    ManageInventoryMethodId: "0",
    SelectedCategoryIds: categoryIds,
    SelectedManufacturerIds: manufacturerIds,
    SelectedDiscountIds: discountIds,
    save: "save",
  };

  const formBody = serializeFormBody(payload);

  const publishResp = http.post(
    `${BASE_URL}${ADMIN_CREATE_PATH}`,
    formBody,
    {
      tags: {name: "POST /Admin/Product/Create"},
      redirects: 5,
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
    }
  );

  const elapsed = Date.now() - t0;

  // Success: redirected to the Edit page for the new product
  const ok =
    publishResp.status === 200 &&
    !isLoginPageResponse(publishResp) &&
    (publishResp.url.includes("/Admin/Product/Edit/") || publishResp.url.includes("/Admin/Product/List"));

  const checks = check(publishResp, {
    "product created (redirect to edit/list)": () => ok,
    "response time < 2000ms": () => elapsed < 2000,
  });

  publishFailures.add(!ok);

  if (ok) {
    publishedProducts.add(1);
    publishDuration.add(elapsed);
  } else {
    const validationSummary = extractValidationSummary(publishResp.body);
    console.warn(
      `[VU ${__VU} iter ${iteration}] Publish failed — ` +
        `status=${publishResp.status} url=${publishResp.url} elapsed=${elapsed}ms` +
        (validationSummary ? ` validation="${validationSummary}"` : "")
    );
  }

  return ok;
}

// VU lifecycle

/**
 * setup() runs once before any VU iteration.
 * It is used only for a quick smoke-test that the app is reachable.
 */
export function setup() {
  const resp = http.get(LOGIN_URL);
  if (resp.status !== 200) {
    throw new Error(
      `nopCommerce does not appear to be running at ${BASE_URL} ` +
        `(GET /login?returnUrl=%2FAdmin returned ${resp.status}). ` +
        `Start the app and the observability stack first.`
    );
  }
  console.log(`Smoke test passed -> target: ${BASE_URL}`);
}

/**
 * default() is the VU function: runs once per iteration.
 *
 * Each virtual user keeps a persistent cookie jar (k6 default), so we
 * log in once and then re-use the session.  We re-login if a publish fails
 * with an auth-like error.
 */
let sessionEstablished = false;

export default function () {
  // Establish session on first iteration (or if reset is needed)
  if (!sessionEstablished) {
    group("admin login", () => {
      sessionEstablished = adminLogin();
    });

    if (!sessionEstablished) {
      sleep(2); // back-off before retry
      return;
    }
  }

  group("publish product", () => {
    const ok = publishProduct(__ITER);
    if (!ok) {
      // Session may have expired: force re-login on next iteration
      sessionEstablished = false;
    }
  });

  // Realistic think time: 0.5 - 2 seconds between iterations
  sleep(randomIntBetween(1, 2) * 0.5);
}

/**
 * teardown() runs once after all VU iterations complete.
 */
export function teardown(data) {
  console.log("Load test finished.");
}
