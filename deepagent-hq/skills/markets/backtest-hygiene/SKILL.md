---
name: backtest-hygiene
description: Rules for backtests that can be trusted - avoiding look-ahead bias, overfitting and unrealistic fills, and matching TradingView's strategy tester. Use for any strategy backtest, paper-trading comparison or Pine Script port.
---

# Backtest hygiene

A backtest is evidence, not proof. Most great-looking backtests are bugs or overfitting.

## Data
- Record the source, symbol, timeframe, date range and timezone of every dataset.
- Use adjusted prices for equities (splits/dividends). For crypto, note the exchange; prices differ.
- Survivorship bias: a universe of "today's S&P 500" silently drops the losers. Say so if you can't fix it.

## No look-ahead
- Signals on bar *t* may only use data available at the close of bar *t*. Enter at the open of *t+1* (or later).
- Indicators must not use future bars (watch pandas `shift`, `rolling(center=True)`, resampling, and anything normalized over the whole series).
- Higher-timeframe data must be taken from the last *completed* higher-timeframe bar.

## Realistic execution
- Always include commission and slippage. Report results at zero cost and at a pessimistic cost.
- Match TradingView's strategy tester when the strategy will be ported: same commission type/value, slippage in ticks, `process_orders_on_close` setting, pyramiding, and initial capital. State these settings explicitly next to the results.

## Overfitting controls
- Split data: in-sample for development, out-of-sample held back and looked at once. Prefer walk-forward.
- Count how many parameter combinations you tried and report it.
- A strategy that only works in a narrow parameter band is fragile. Show a sensitivity sweep.
- Minimum evidence before calling anything promising: enough trades to mean something (report the count), positive out-of-sample result, and a drawdown C could actually sit through.

## Report every time
Trades, win rate, profit factor, average win/loss, max drawdown (and duration), CAGR or total return, exposure time, Sharpe/Sortino, results by year, and the exact settings. Include the equity curve and the worst trades. Say plainly what could make the result wrong.
