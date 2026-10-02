"""Regression tests for #1545: agent_identity spelling falls through.

The provider read the agent identifier with
``kwargs.get("agent_id", _DEFAULT_AGENT_ID)`` — a caller sending the alternate
``agent_identity`` spelling silently got the default agent, mis-attributing
every stored memory. The fix tries ``agent_id`` first, then ``agent_identity``,
then the default, and also falls through when ``agent_id`` is present but empty.

Run with the standard library only (no pytest / hermes SDK required):
    python -m unittest discover -s tests -v
"""

import sys
import types
import unittest
from pathlib import Path

# ── stub the hermes SDK before importing the package ──
# The plugin's top-level `from agent.memory_provider import MemoryProvider`
# requires the host runtime; the resolution logic under test doesn't.
pkg_root = Path(__file__).resolve().parents[2]  # .../memory/ (contains the package)
agent_pkg = types.ModuleType("agent")
mp_mod = types.ModuleType("agent.memory_provider")


class MemoryProvider:  # minimal stand-in for the host base class
    pass


mp_mod.MemoryProvider = MemoryProvider
agent_pkg.memory_provider = mp_mod
sys.modules.setdefault("agent", agent_pkg)
sys.modules["agent.memory_provider"] = mp_mod
sys.path.insert(0, str(pkg_root))

from memory_tencentdb import GatewaySupervisor, MemoryTencentdbProvider  # noqa: E402


class _FakeSupervisor:
    """Enough supervisor for initialize(): reports 'already running' so no
    background thread is started, and no real gateway is touched."""

    def __init__(self, **kwargs):
        self.client = object()

    def is_running(self):
        return True

    def ensure_running(self):
        return True


class TestAgentIdResolution(unittest.TestCase):
    def setUp(self):
        import memory_tencentdb as mod

        self._mod = mod
        self._orig_supervisor = mod.GatewaySupervisor
        mod.GatewaySupervisor = _FakeSupervisor
        # keep the test side-effect free: no watchdog, no background thread
        MemoryTencentdbProvider._start_watchdog = lambda self: None

    def tearDown(self):
        self._mod.GatewaySupervisor = self._orig_supervisor

    def _provider(self, **kwargs):
        p = MemoryTencentdbProvider()
        p.initialize("session-1", **kwargs)
        return p

    def test_explicit_agent_id_wins_over_identity(self):
        self.assertEqual(self._provider(agent_id="a-explicit", agent_identity="a-identity")._agent_id, "a-explicit")

    def test_agent_identity_is_used_as_fallback(self):
        self.assertEqual(self._provider(agent_identity="a-identity")._agent_id, "a-identity")

    def test_empty_agent_id_falls_through_to_identity(self):
        self.assertEqual(self._provider(agent_id="", agent_identity="a-identity")._agent_id, "a-identity")

    def test_default_when_neither_spelling_is_present(self):
        self.assertEqual(self._provider()._agent_id, "default")


if __name__ == "__main__":
    unittest.main()
