"""OHLC aggregation from the finest stored bars.

If true 1-second data exists, any integer-second timeframe can be built
from it without interpolation or fabrication.
"""


def aggregate(rows, seconds: int):
    if seconds <= 0:
        raise ValueError("seconds must be positive")

    buckets: dict[int, list] = {}
    for row in rows:
        bucket_key = (int(row["time"]) // seconds) * seconds
        if bucket_key not in buckets:
            buckets[bucket_key] = [
                row["open"],
                row["high"],
                row["low"],
                row["close"],
                row.get("volume", 0),
            ]
        else:
            b = buckets[bucket_key]
            b[1] = max(b[1], row["high"])
            b[2] = min(b[2], row["low"])
            b[3] = row["close"]
            b[4] += row.get("volume", 0)

    return [
        {"time": k, "open": b[0], "high": b[1], "low": b[2], "close": b[3], "volume": b[4]}
        for k, b in sorted(buckets.items())
    ]


def from_1m(rows, seconds: int):
    # Kept separate so callers can explicitly reject sub-minute requests
    # when the only source available is 1-minute resolution.
    if seconds < 60:
        raise ValueError("1-minute data cannot reconstruct true 1-second movement")
    return aggregate(rows, seconds)
