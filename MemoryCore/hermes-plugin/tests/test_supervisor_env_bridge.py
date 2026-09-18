"""Unit tests for supervisor.bridge_llm_env (issue #1386).

The plugin schema advertises LLM credentials as MEMORY_TENCENTDB_LLM_*,
while the spawned Gateway reads TDAI_LLM_* (src/gateway/config.ts).
The bridge must copy the former onto the latter without ever clobbering
an explicit TDAI_LLM_* the operator set.

Runs under pytest, and also standalone: ``python test_supervisor_env_bridge.py``.
"""

import os
import sys
import types

# The plugin package __init__ re-exports MemoryProvider from the Hermes host
# SDK (``agent.memory_provider``), which is not importable outside Hermes.
# Stub that single symbol so supervisor.py — whose code under test only uses
# the stdlib — can be imported for testing.
_agent_pkg = types.ModuleType("agent")
_provider_mod = types.ModuleType("agent.memory_provider")


class _MemoryProvider:  # minimal stand-in; never exercised here
    pass


_provider_mod.MemoryProvider = _MemoryProvider
_agent_pkg.memory_provider = _provider_mod
sys.modules.setdefault("agent", _agent_pkg)
sys.modules.setdefault("agent.memory_provider", _provider_mod)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory.memory_tencentdb import supervisor  # noqa: E402


def test_bridges_all_three_names_when_targets_unset():
    env = {
        "MEMORY_TENCENTDB_LLM_API_KEY": "sk-test",
        "MEMORY_TENCENTDB_LLM_BASE_URL": "https://vendor.example/v1",
        "MEMORY_TENCENTDB_LLM_MODEL": "model-a",
    }
    supervisor.bridge_llm_env(env)
    assert env["TDAI_LLM_API_KEY"] == "sk-test"
    assert env["TDAI_LLM_BASE_URL"] == "https://vendor.example/v1"
    assert env["TDAI_LLM_MODEL"] == "model-a"
    # the original names must survive for the provider itself
    assert env["MEMORY_TENCENTDB_LLM_API_KEY"] == "sk-test"


def test_does_not_clobber_explicit_tdai_llm_values():
    env = {
        "MEMORY_TENCENTDB_LLM_API_KEY": "sk-hermes-name",
        "TDAI_LLM_API_KEY": "sk-operator-set",
        "MEMORY_TENCENTDB_LLM_MODEL": "model-hermes",
        "TDAI_LLM_MODEL": "model-operator",
    }
    supervisor.bridge_llm_env(env)
    assert env["TDAI_LLM_API_KEY"] == "sk-operator-set"
    assert env["TDAI_LLM_MODEL"] == "model-operator"


def test_empty_memory_value_is_treated_as_unset():
    env = {"MEMORY_TENCENTDB_LLM_API_KEY": "", "TDAI_LLM_API_KEY": "sk-keep"}
    supervisor.bridge_llm_env(env)
    assert env["TDAI_LLM_API_KEY"] == "sk-keep"


def test_partial_config_bridges_only_present_names():
    env = {"MEMORY_TENCENTDB_LLM_API_KEY": "sk-only"}
    supervisor.bridge_llm_env(env)
    assert env["TDAI_LLM_API_KEY"] == "sk-only"
    assert "TDAI_LLM_BASE_URL" not in env
    assert "TDAI_LLM_MODEL" not in env


def test_unset_memory_name_and_no_target_leaves_env_untouched():
    env = {"UNRELATED": "value"}
    result = supervisor.bridge_llm_env(env)
    assert result is env  # in-place, same object handed back to the spawn block
    assert "TDAI_LLM_API_KEY" not in env
    assert env == {"UNRELATED": "value"}


def test_bridge_covers_exactly_the_documented_schema_names():
    assert supervisor.LLM_ENV_BRIDGE == (
        ("MEMORY_TENCENTDB_LLM_API_KEY", "TDAI_LLM_API_KEY"),
        ("MEMORY_TENCENTDB_LLM_BASE_URL", "TDAI_LLM_BASE_URL"),
        ("MEMORY_TENCENTDB_LLM_MODEL", "TDAI_LLM_MODEL"),
    )


def _capture_warnings():
    """Attach a capturing handler to the supervisor logger; returns records list."""
    import logging

    records = []
    handler = logging.Handler()
    handler.emit = lambda record: records.append(record)
    sup_logger = logging.getLogger("memory.memory_tencentdb.supervisor")
    sup_logger.addHandler(handler)
    sup_logger.setLevel(logging.WARNING)
    return records, sup_logger, handler


def test_warns_when_no_source_yields_tdai_llm_api_key():
    # #1386 follow-up: "bridged but empty" and "not bridged" must be
    # distinguishable from the outside — a missing resolved key warns.
    records, sup_logger, handler = _capture_warnings()
    try:
        supervisor.bridge_llm_env({})
    finally:
        sup_logger.removeHandler(handler)
    assert any("TDAI_LLM_API_KEY" in r.getMessage() for r in records)


def test_no_warning_when_key_resolves_from_either_source():
    records, sup_logger, handler = _capture_warnings()
    try:
        supervisor.bridge_llm_env({"MEMORY_TENCENTDB_LLM_API_KEY": "sk-hermes"})
        supervisor.bridge_llm_env({"TDAI_LLM_API_KEY": "sk-operator"})
    finally:
        sup_logger.removeHandler(handler)
    assert not any("TDAI_LLM_API_KEY" in r.getMessage() for r in records)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(
        (k, v) for k, v in globals().items()
        if k.startswith("test_") and callable(v)
    ):
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
