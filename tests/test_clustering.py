from __future__ import annotations

from app import clustering, ingest


CSV = """speed,rpm
0,700
1,720
2,740
80,3000
82,3100
84,3200
"""


def test_clustering_adds_a_complete_cluster_column(ingest_csv) -> None:
    dataset = ingest_csv(CSV)

    result = clustering.run_clustering(dataset["id"], ["speed", "rpm"], k=2)

    assert result["clustered_rows"] == 6
    assert result["fit_sample_rows"] == 6
    assert sum(center["count"] for center in result["centers"]) == 6
    schema = ingest.dataset_schema(dataset["id"])
    assert schema["columns"][-1] == {"name": "cluster", "type": "BIGINT", "kind": "numeric"}
