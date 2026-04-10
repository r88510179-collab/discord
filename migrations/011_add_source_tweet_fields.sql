-- Store explicit source tweet info for accurate "View Original" links
ALTER TABLE bets ADD COLUMN source_tweet_id TEXT;
ALTER TABLE bets ADD COLUMN source_tweet_handle TEXT;
