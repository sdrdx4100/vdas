"""REST API ルーター。"""
from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import clustering, cohorts, db, ingest, methods, queries

router = APIRouter(prefix="/api")


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (ingest.IngestError, queries.QueryError) as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------- データセット ----------

@router.get("/datasets")
def list_datasets():
    return ingest.list_datasets()


@router.post("/datasets/upload")
async def upload_dataset(file: UploadFile = File(...), name: str | None = Form(None),
                         tags: str | None = Form(None)):
    try:
        tag_list = json.loads(tags) if tags else []
        assert isinstance(tag_list, list)
    except (ValueError, AssertionError):
        raise HTTPException(status_code=400, detail="tags は JSON 配列で指定してください")
    return _wrap(ingest.ingest_file, file.file, file.filename or "upload.csv", name, tag_list)


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str):
    _wrap(ingest.delete_dataset, dataset_id)
    return {"ok": True}


class TagsUpdate(BaseModel):
    tags: list[str]


@router.put("/datasets/{dataset_id}/tags")
def put_tags(dataset_id: str, req: TagsUpdate):
    return _wrap(ingest.update_tags, dataset_id, req.tags)


@router.get("/tags")
def get_tags():
    return ingest.all_tags()


class BulkTagsRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=1)
    add: list[str] = []
    remove: list[str] = []


@router.post("/datasets/tags/bulk")
def post_bulk_tags(req: BulkTagsRequest):
    return _wrap(ingest.bulk_update_tags, req.dataset_ids, req.add, req.remove)


class BulkDeleteRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=1)


@router.post("/datasets/bulk-delete")
def post_bulk_delete(req: BulkDeleteRequest):
    return _wrap(ingest.bulk_delete, req.dataset_ids)


class DeleteAllRequest(BaseModel):
    include_views: bool = False


@router.post("/datasets/delete-all")
def post_delete_all(req: DeleteAllRequest):
    return _wrap(ingest.delete_all, req.include_views)


@router.get("/datasets/{dataset_id}/schema")
def get_schema(dataset_id: str):
    return _wrap(ingest.dataset_schema, dataset_id)


@router.get("/datasets/{dataset_id}/preview")
def get_preview(dataset_id: str, limit: int = 100):
    return _wrap(queries.preview, dataset_id, min(limit, 500))


@router.get("/datasets/{dataset_id}/summary")
def get_summary(dataset_id: str):
    return _wrap(queries.summary, dataset_id)


class FilterSpec(BaseModel):
    column: str
    op: str
    value: Any = None


class TimeseriesRequest(BaseModel):
    x: str
    ys: list[str] = Field(min_length=1)
    filters: list[FilterSpec] = []
    max_points: int | None = None


@router.post("/datasets/{dataset_id}/timeseries")
def post_timeseries(dataset_id: str, req: TimeseriesRequest):
    return _wrap(queries.timeseries, dataset_id, req.x, req.ys,
                 [f.model_dump() for f in req.filters], req.max_points)


class HistogramRequest(BaseModel):
    column: str
    bins: int = 40
    filters: list[FilterSpec] = []


@router.post("/datasets/{dataset_id}/histogram")
def post_histogram(dataset_id: str, req: HistogramRequest):
    return _wrap(queries.histogram, dataset_id, req.column, req.bins,
                 [f.model_dump() for f in req.filters])


class CorrelationRequest(BaseModel):
    columns: list[str] | None = None
    filters: list[FilterSpec] = []


@router.post("/datasets/{dataset_id}/correlation")
def post_correlation(dataset_id: str, req: CorrelationRequest):
    return _wrap(queries.correlation, dataset_id, req.columns,
                 [f.model_dump() for f in req.filters])


class ScatterRequest(BaseModel):
    x: str
    y: str
    color: str | None = None
    filters: list[FilterSpec] = []
    max_points: int | None = None


@router.post("/datasets/{dataset_id}/scatter")
def post_scatter(dataset_id: str, req: ScatterRequest):
    return _wrap(queries.scatter, dataset_id, req.x, req.y, req.color,
                 [f.model_dump() for f in req.filters], req.max_points)


class ChartRequest(BaseModel):
    kind: str
    x: str | None = None
    y: str | None = None
    color: str | None = None
    agg: str = "avg"
    bins: int = 40
    filters: list[FilterSpec] = []
    max_points: int | None = None


@router.post("/datasets/{dataset_id}/chart")
def post_chart(dataset_id: str, req: ChartRequest):
    return _wrap(queries.chart, dataset_id, req.kind, req.x, req.y, req.color,
                 req.agg, req.bins, [f.model_dump() for f in req.filters], req.max_points)


class ChartGroupSpec(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    dataset_ids: list[str] = Field(min_length=1)


class ChartGroupsRequest(BaseModel):
    groups: list[ChartGroupSpec] = Field(min_length=1)
    kind: str
    x: str | None = None
    y: str | None = None
    agg: str = "avg"
    bins: int = 40
    filters: list[FilterSpec] = []
    max_points: int | None = None


@router.post("/chart/groups")
def post_chart_groups(req: ChartGroupsRequest):
    return _wrap(queries.chart_groups, [g.model_dump() for g in req.groups],
                 req.kind, req.x, req.y, req.agg, req.bins,
                 [f.model_dump() for f in req.filters], req.max_points)


# ---------- クラスタリング ----------

class ClusteringRequest(BaseModel):
    features: list[str] = Field(min_length=1)
    k: int = 4
    column_name: str = "cluster"


@router.post("/datasets/{dataset_id}/cluster")
def post_cluster(dataset_id: str, req: ClusteringRequest):
    return _wrap(clustering.run_clustering, dataset_id, req.features, req.k, req.column_name)


# ---------- データセット比較 ----------

class CompareHistogramRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    column: str
    bins: int = 40
    filters: list[FilterSpec] = []
    as_category: bool = False  # 数値列でも値をカテゴリ扱いして構成比 (割合%) を出す


@router.post("/compare/histogram")
def post_compare_histogram(req: CompareHistogramRequest):
    return _wrap(queries.compare_histogram, req.dataset_ids, req.column, req.bins,
                 [f.model_dump() for f in req.filters], req.as_category)


class CompareGroupStatsRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    column: str
    group_by: str
    filters: list[FilterSpec] = []


@router.post("/compare/groupstats")
def post_compare_groupstats(req: CompareGroupStatsRequest):
    return _wrap(queries.compare_groupstats, req.dataset_ids, req.column, req.group_by,
                 [f.model_dump() for f in req.filters])


class CompareSummaryRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    column: str
    filters: list[FilterSpec] = []


@router.post("/compare/summary")
def post_compare_summary(req: CompareSummaryRequest):
    return _wrap(queries.compare_summary, req.dataset_ids, req.column,
                 [f.model_dump() for f in req.filters])


class CompareCurveRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    x: str
    y: str
    bins: int = 40
    filters: list[FilterSpec] = []


@router.post("/compare/curve")
def post_compare_curve(req: CompareCurveRequest):
    return _wrap(queries.compare_curve, req.dataset_ids, req.x, req.y, req.bins,
                 [f.model_dump() for f in req.filters])


class CompareCdfRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    column: str
    filters: list[FilterSpec] = []


@router.post("/compare/cdf")
def post_compare_cdf(req: CompareCdfRequest):
    return _wrap(queries.compare_cdf, req.dataset_ids, req.column,
                 [f.model_dump() for f in req.filters])


class CompareDiffRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2)
    baseline: str | None = None
    filters: list[FilterSpec] = []


@router.post("/compare/diff")
def post_compare_diff(req: CompareDiffRequest):
    return _wrap(queries.compare_diff, req.dataset_ids, req.baseline,
                 [f.model_dump() for f in req.filters])


# ---------- タグ比較グループ ----------

class CohortSpec(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    tags: list[str] = Field(min_length=1)
    match: Literal["all", "any"] = "all"


class CohortResolveRequest(BaseModel):
    cohorts: list[CohortSpec] = Field(min_length=1)


class CohortHistogramRequest(CohortResolveRequest):
    column: str
    bins: int = 40
    filters: list[FilterSpec] = Field(default_factory=list)
    as_category: bool = False


class CohortDatasetSummaryRequest(CohortResolveRequest):
    column: str
    metric: Literal["avg", "q50", "q75", "std", "max"] = "avg"
    filters: list[FilterSpec] = Field(default_factory=list)


class CohortMultiSummaryRequest(CohortResolveRequest):
    columns: list[str] = Field(min_length=1, max_length=20)
    metric: Literal["avg", "q50", "q75", "std", "max"] = "avg"
    filters: list[FilterSpec] = Field(default_factory=list)


class CohortHistogram2DRequest(CohortResolveRequest):
    x: str
    y: str
    bins_x: int = 40
    bins_y: int = 40
    filters: list[FilterSpec] = Field(default_factory=list)


class CohortEventsRequest(CohortResolveRequest):
    state_column: str
    value: str
    order_by: str
    time_column: str | None = None
    secondary_column: str | None = None
    filters: list[FilterSpec] = Field(default_factory=list)


class CohortTransitionsRequest(CohortResolveRequest):
    state_column: str
    order_by: str
    filters: list[FilterSpec] = Field(default_factory=list)
    denominator_column: str | None = None
    denominator_scale: float = Field(default=1.0, gt=0)


def _cohort_dicts(req: CohortResolveRequest) -> list[dict[str, Any]]:
    return [cohort.model_dump() for cohort in req.cohorts]


@router.post("/compare/cohorts/resolve")
def post_resolve_cohorts(req: CohortResolveRequest):
    return _wrap(cohorts.resolve_cohorts, _cohort_dicts(req))


@router.post("/compare/cohorts/histogram")
def post_cohort_histogram(req: CohortHistogramRequest):
    return _wrap(
        cohorts.compare_histogram,
        _cohort_dicts(req),
        req.column,
        req.bins,
        [filter_spec.model_dump() for filter_spec in req.filters],
        req.as_category,
    )


@router.post("/compare/cohorts/summary")
def post_cohort_dataset_summary(req: CohortDatasetSummaryRequest):
    return _wrap(
        cohorts.compare_dataset_summary,
        _cohort_dicts(req),
        req.column,
        req.metric,
        [filter_spec.model_dump() for filter_spec in req.filters],
    )


@router.post("/compare/cohorts/multisummary")
def post_cohort_multi_summary(req: CohortMultiSummaryRequest):
    return _wrap(
        cohorts.compare_multi_summary,
        _cohort_dicts(req),
        req.columns,
        req.metric,
        [filter_spec.model_dump() for filter_spec in req.filters],
    )


@router.post("/compare/cohorts/histogram2d")
def post_cohort_histogram2d(req: CohortHistogram2DRequest):
    return _wrap(
        cohorts.compare_histogram2d,
        _cohort_dicts(req),
        req.x,
        req.y,
        req.bins_x,
        req.bins_y,
        [filter_spec.model_dump() for filter_spec in req.filters],
    )


class CohortRegressionRequest(CohortResolveRequest):
    x: str
    y: str
    filters: list[FilterSpec] = Field(default_factory=list)


@router.post("/compare/cohorts/regression")
def post_cohort_regression(req: CohortRegressionRequest):
    return _wrap(methods.cohort_regression, _cohort_dicts(req), req.x, req.y,
                 [f.model_dump() for f in req.filters])


class CohortPcaRequest(CohortResolveRequest):
    columns: list[str] = Field(min_length=2, max_length=12)
    filters: list[FilterSpec] = Field(default_factory=list)


@router.post("/compare/cohorts/pca")
def post_cohort_pca(req: CohortPcaRequest):
    return _wrap(methods.cohort_pca, _cohort_dicts(req), req.columns,
                 [f.model_dump() for f in req.filters])


class CohortCorrelationRequest(CohortResolveRequest):
    columns: list[str] | None = None
    filters: list[FilterSpec] = Field(default_factory=list)


@router.post("/compare/cohorts/correlation")
def post_cohort_correlation(req: CohortCorrelationRequest):
    return _wrap(methods.cohort_correlation, _cohort_dicts(req), req.columns,
                 [f.model_dump() for f in req.filters])


class CohortSpectrumRequest(CohortResolveRequest):
    signal: str
    order_by: str
    band_low: float = 4.0
    band_high: float = 8.0
    filters: list[FilterSpec] = Field(default_factory=list)


@router.post("/compare/cohorts/spectrum")
def post_cohort_spectrum(req: CohortSpectrumRequest):
    return _wrap(methods.cohort_spectrum, _cohort_dicts(req), req.signal, req.order_by,
                 [f.model_dump() for f in req.filters], (req.band_low, req.band_high))


@router.post("/compare/cohorts/events")
def post_cohort_events(req: CohortEventsRequest):
    return _wrap(
        cohorts.compare_events,
        _cohort_dicts(req),
        req.state_column,
        req.value,
        req.order_by,
        req.time_column,
        req.secondary_column,
        [filter_spec.model_dump() for filter_spec in req.filters],
    )


@router.post("/compare/cohorts/transitions")
def post_cohort_transitions(req: CohortTransitionsRequest):
    return _wrap(
        cohorts.compare_transitions,
        _cohort_dicts(req),
        req.state_column,
        req.order_by,
        [filter_spec.model_dump() for filter_spec in req.filters],
        req.denominator_column,
        req.denominator_scale,
    )


# ---------- 保存ビュー (可視化状態・条件の保存) ----------

class SavedViewCreate(BaseModel):
    name: str
    kind: str  # 'timeseries' | 'stats' | 'compare'
    dataset_id: str | None = None
    config: dict[str, Any]


@router.get("/views")
def list_views():
    rows = db.meta_query("SELECT * FROM saved_views ORDER BY created_at DESC")
    for r in rows:
        r["config"] = json.loads(r["config"])
    return rows


@router.post("/views")
def create_view(req: SavedViewCreate):
    if req.kind not in ("timeseries", "stats", "compare", "explore"):
        raise HTTPException(status_code=400, detail="kind は timeseries / stats / compare / explore を指定してください")
    view_id = uuid.uuid4().hex[:12]
    db.meta_execute(
        "INSERT INTO saved_views (id, name, kind, dataset_id, config) VALUES (?, ?, ?, ?, ?)",
        (view_id, req.name, req.kind, req.dataset_id, json.dumps(req.config, ensure_ascii=False)),
    )
    return {"id": view_id}


@router.delete("/views/{view_id}")
def delete_view(view_id: str):
    db.meta_execute("DELETE FROM saved_views WHERE id = ?", (view_id,))
    return {"ok": True}


# ---------- ラベルセット (見たい信号列のセット) ----------

class LabelSetCreate(BaseModel):
    name: str
    dataset_id: str | None = None
    columns: list[str] = Field(min_length=1)


@router.get("/labelsets")
def list_labelsets():
    rows = db.meta_query("SELECT * FROM label_sets ORDER BY created_at DESC")
    for r in rows:
        r["columns"] = json.loads(r["columns"])
    return rows


@router.post("/labelsets")
def create_labelset(req: LabelSetCreate):
    ls_id = uuid.uuid4().hex[:12]
    db.meta_execute(
        "INSERT INTO label_sets (id, name, dataset_id, columns) VALUES (?, ?, ?, ?)",
        (ls_id, req.name, req.dataset_id, json.dumps(req.columns, ensure_ascii=False)),
    )
    return {"id": ls_id}


@router.delete("/labelsets/{labelset_id}")
def delete_labelset(labelset_id: str):
    db.meta_execute("DELETE FROM label_sets WHERE id = ?", (labelset_id,))
    return {"ok": True}
