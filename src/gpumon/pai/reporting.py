"""Calendar reporting boundaries, shared by the live API and synthetic demo."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def reporting_period(now, cfg, previous=False):
    zone = ZoneInfo(cfg.ranking_timezone)
    local = datetime.fromtimestamp(now, zone)
    hour, minute = map(int, cfg.ranking_reset_time.split(":"))
    day = local.date() - timedelta(days=(local.weekday() - WEEKDAYS.index(cfg.ranking_week_start)) % 7)

    def boundary(date):
        # fold=0 chooses the first occurrence of a repeated wall time. A nonexistent
        # spring-forward time resolves forward by the DST gap (02:30 -> 03:30).
        return datetime(date.year, date.month, date.day, hour, minute, tzinfo=zone, fold=0).timestamp()

    start = boundary(day)
    if start > now:
        day -= timedelta(days=7)
        start = boundary(day)
    if previous:
        return boundary(day - timedelta(days=7)), start
    return start, now


def reporting_metadata(cfg):
    return {"timezone": cfg.ranking_timezone, "week_start": cfg.ranking_week_start,
            "reset_time": cfg.ranking_reset_time}
