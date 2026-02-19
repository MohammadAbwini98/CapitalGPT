# CapitalGPT

## Project name
CapitalGPT

## User requests (verbatim)
1.project name => CapitalGPT.  
2.put comment in each line of code.  
2.use capital.com api or web socket to fetch current price, ask, bid, liquidity, volume ... etc per each second tick by tick [high frequency]. Refer back to capital.com api integration documentation.  
3.handle any error message may come from the api or websocket.  
4.check if market closed  or temporarily closed.  
5. any configuration put it in .env file [APIKEY, instrument(silver, gold, ethusd, btcusd ... etc), account type (live, demo), ... etc.].  
6.print data instantly in terminal.  
7.create readme file which contains my requests and archived goals and suggested.

## Achieved goals
- ✅ Node.js + TypeScript project scaffold named CapitalGPT
- ✅ `.env` configuration + validation
- ✅ REST session creation with error handling
- ✅ Stream client (Lightstreamer) with reconnect + subscription error handling
- ✅ Market closed / temporarily closed detection via REST polling
- ✅ Prints stream updates immediately to terminal
- ✅ Each line of code commented (as requested)

## What you must verify in Capital.com docs
This project includes placeholders that must match Capital.com’s integration docs:
- REST endpoints (session + market details path)
- Header names for API key and tokens
- Lightstreamer endpoint URL
- Lightstreamer authentication mapping (user/password vs custom params)
- Stream item naming and field names (BID/OFFER/VOLUME/etc)

## Run
```bash
cp .env.example .env
npm i
npm run dev
```

## Suggestions
- Auto-refresh session when REST returns 401/403, then reconnect stream
- Make stream fields configurable per instrument
- Add structured logging (pino) + optional file output
- Add throttling/backpressure if terminal output becomes too fast
