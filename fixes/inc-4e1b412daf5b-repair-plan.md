# Repair plan for inc-4e1b412daf5b: tracezeta-pre-fix-inc-4e1b412daf5b

Root causes: wrong-tool-selected, external-service-failure
- fetch_currency_price: tool 'fetch_currency_price' -> 'get_exchange_rate' (exact argument-shape match in the registry)
- fetch_currency_price: external service failure (network/timeout/HTTP): task and code are correct; retried unchanged — resolves only if the re-run passes
