-- Track the Discord message ID in #slip-feed for lifecycle management
ALTER TABLE bets ADD COLUMN slipfeed_message_id TEXT;
