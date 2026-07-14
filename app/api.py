"""REST API ルーター。"""
from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import clustering, db, ingest, queries

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


@router.post("/compare/histogram")
def post_compare_histogram(req: CompareHistogramRequest):
    return _wrap(queries.compare_histogram, req.dataset_ids, req.column, req.bins,
                 [f.model_dump() for f in req.filters])


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
    if req.kind not in ("timeseries", "stats", "compare"):
        raise HTTPException(status_code=400, detail="kind は timeseries / stats / compare を指定してください")
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
