# Repair plan for inc-9c28823a4d40: tracezeta-pre-fix-inc-9c28823a4d40

Root causes: wrong-tool-selected, external-service-failure
- fetch_currency_price: tool 'fetch_currency_price' -> 'get_exchange_rate' (exact argument-shape match in the registry)
- fetch_currency_price: external service failure (network/timeout/HTTP): task and code are correct; retried unchanged — resolves only if the re-run passes
