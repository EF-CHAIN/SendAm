# Error boundary support details

The shared error boundary used by the admin and landing apps keeps its generic
recovery message and navigation actions. Expand **Technical Details** to inspect
the error name, message, JavaScript stack, React component stack, and browser user
agent. **Copy Error Details** copies the same plain-text report for a support
ticket and announces success. If clipboard access is unavailable or denied, the
report remains selectable for manual copying and the button can be retried.

The report strips URL locations and local paths and redacts common credential
assignments, authorization/cookie lines, bearer tokens, JWTs, Stellar secret keys,
PEM private keys, and email addresses. Each field is capped at 6,000 characters.
It never serializes request/response bodies or the normalized internal error
object. These rules cover recognizable patterns, not arbitrary sensitive prose;
review the report before sharing it. Details are rendered as text, never HTML.

The native disclosure is keyboard accessible and collapsed initially. Retrying
clears the previous report, expansion state, and copy feedback, including when the
child fails again. Custom fallback render functions retain their existing API.

Run the regression tests with:

```sh
npm test --workspace=apps/landing -- src/ErrorBoundary.details.test.jsx src/ErrorBoundary.test.jsx
npm test --workspace=apps/admin -- src/components/ErrorBoundary.test.jsx
```
