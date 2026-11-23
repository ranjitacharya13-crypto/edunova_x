// Browser E2E contract tests for LoginCard, Demo Student login, rate-limit
// recovery, and session expiration handling.
import { test, expect } from "@playwright/test";

test("login error recovery, per-account 429 isolation, and Demo Student sign-in", async ({ page }) => {
  let loginCalls = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body, status = 200, headers = {}) =>
      route.fulfill({ status, json: body, headers });

    if (path === "/api/auth/login") {
      loginCalls += 1;
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.email === "student@edunova.demo" && payload.password === "Student@12345") {
        return json({
          token: "explicit-browser-test-token",
          user: { id: "64d000000000000000000010", role: "student", name: "Demo Student", email: "student@edunova.demo" },
        });
      }
      if (payload.email === "locked@example.invalid") {
        return json(
          {
            error: "Too many sign-in attempts. Please wait a moment and try again.",
            retryAfterSeconds: 25,
            bucket: "account",
          },
          429,
          { "Retry-After": "25" }
        );
      }
      return json({ error: "Invalid credentials" }, 401);
    }

    if (path === "/api/ai/health") return json({ modelReady: true, readyForTraffic: true, status: "ready" });
    if (path === "/api/timetable/today") return json({ day: "Monday", periods: [], hasTimetable: false });
    return json({});
  });

  await page.goto("/");

  // 1. Invalid password recovers loading state and displays error
  await page.getByPlaceholder(/^email$/i).fill("alice@example.invalid");
  await page.getByPlaceholder(/password/i).fill("wrong-password");
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid credentials");
  await expect(page.getByRole("button", { name: /^Sign In$/i })).toBeEnabled();

  // 2. Per-account 429 disables Sign In for locked@example.invalid, but Demo Student remains enabled
  await page.getByPlaceholder(/^email$/i).fill("locked@example.invalid");
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  await expect(page.getByRole("button", { name: /Try again in/i })).toBeDisabled();
  const demoBtn = page.getByRole("button", { name: /Login as Demo Student/i });
  await expect(demoBtn).toBeEnabled();

  // 3. Clicking Login as Demo Student succeeds and enters Home view
  await demoBtn.click();
  await expect(page.getByText("Demo Student").first()).toBeVisible();
  expect(loginCalls).toBe(3);
});
