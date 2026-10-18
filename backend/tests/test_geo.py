"""
test_geo.py - Unit tests for GeoAlchemy2 geometry normalization and coordinate extraction.

Guarantees that Job.latitude and Job.longitude never raise:
TypeError: Only WKBElement and WKTElement objects are supported
even if location is assigned a raw string, WKTElement, or None.
"""

from geoalchemy2.elements import WKTElement
from app.core.geo import to_wkt_point, to_wkt_element, extract_coordinates
from app.models.job import Job
from app.models.service import ServiceListing


def test_extract_coordinates_from_wkt_element():
    elem = to_wkt_point(6.5244, 3.3792)
    assert isinstance(elem, WKTElement)
    assert elem.srid == 4326
    lat, lon = extract_coordinates(elem)
    assert lat == 6.5244
    assert lon == 3.3792


def test_extract_coordinates_from_string():
    raw_srid = "SRID=4326;POINT(3.3792 6.5244)"
    lat, lon = extract_coordinates(raw_srid)
    assert lat == 6.5244
    assert lon == 3.3792

    raw_point = "POINT(3.3792 6.5244)"
    lat2, lon2 = extract_coordinates(raw_point)
    assert lat2 == 6.5244
    assert lon2 == 3.3792


def test_to_wkt_element_conversion():
    converted = to_wkt_element("SRID=4326;POINT(3.3792 6.5244)")
    assert isinstance(converted, WKTElement)
    assert converted.srid == 4326
    assert converted.data == "POINT(3.3792 6.5244)"

    dict_converted = to_wkt_element({"latitude": 6.5244, "longitude": 3.3792})
    assert isinstance(dict_converted, WKTElement)
    assert dict_converted.srid == 4326


def test_job_model_latitude_longitude_robustness():
    # 1. Location as WKTElement
    job_wkt = Job(title="Test WKT")
    job_wkt.location = to_wkt_point(6.5244, 3.3792)
    assert job_wkt.latitude == 6.5244
    assert job_wkt.longitude == 3.3792

    # 2. Location as raw string (must NOT raise TypeError: Only WKBElement and WKTElement...)
    job_str = Job(title="Test String")
    job_str.location = "SRID=4326;POINT(3.3792 6.5244)"
    assert job_str.latitude == 6.5244
    assert job_str.longitude == 3.3792

    # 3. Location as None
    job_none = Job(title="Test None")
    job_none.location = None
    assert job_none.latitude is None
    assert job_none.longitude is None


def test_service_model_latitude_longitude_robustness():
    svc_str = ServiceListing(title="Test Svc")
    svc_str.location = "SRID=4326;POINT(3.3792 6.5244)"
    assert svc_str.latitude == 6.5244
    assert svc_str.longitude == 3.3792

    svc_wkt = ServiceListing(title="Test Svc WKT")
    svc_wkt.location = to_wkt_point(6.5244, 3.3792)
    assert svc_wkt.latitude == 6.5244
    assert svc_wkt.longitude == 3.3792
