"""PLAF203 schedule wire vectors from the successful cloud proxy capture."""
import copy
import importlib.util
import json
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('schedule_test_devices', ROOT / 'addon/app/devices.py')
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'aiomqtt': Mock(), 'ha_mqtt': Mock(), 'device_types': Mock()}), \
        patch('logging.handlers.RotatingFileHandler', return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)
CAPTURED = json.loads((ROOT / 'tests/fixtures/plaf203_schedule_cloud.json').read_text())


class ScheduleWireTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        model = patch.object(devices, '_mqtt_model', return_value='PLAF203')
        model.start()
        self.addCleanup(model.stop)
        devices._devices = {'feeder': ('PLAF203', 'camera_feeder')}
        devices._client_ref = Mock(publish=AsyncMock())
        self.plans = copy.deepcopy(CAPTURED['GET_FEEDING_PLAN_EVENT'])
        self.storage = SimpleNamespace(schedules_paused=lambda _: False,
                                       get_active_feeding_plans=lambda _: self.plans)

    async def test_service_push_matches_captured_plan_payloads(self):
        before = copy.deepcopy(self.plans)
        with patch.dict(sys.modules, {'storage': self.storage}):
            self.assertTrue(await devices.send_feeding_plans('feeder', self.plans))
        call = devices._client_ref.publish.await_args
        self.assertEqual(call.args[0], 'dl/PLAF203/feeder/device/service/sub')
        payload = json.loads(call.args[1])
        self.assertEqual(payload['cmd'], 'FEEDING_PLAN_SERVICE')
        self.assertCountEqual(payload['plans'], CAPTURED['FEEDING_PLAN_SERVICE'])
        self.assertEqual(self.plans, before)

    async def test_event_reply_echoes_request_id_and_uses_unpadded_days(self):
        self.plans = copy.deepcopy(CAPTURED['FEEDING_PLAN_SERVICE'])
        with patch.dict(sys.modules, {'storage': self.storage}):
            await devices._respond_feeding_plan('feeder', 'dl/PLAF203/feeder/device/event/post', 'request-id')
        call = devices._client_ref.publish.await_args
        self.assertEqual(call.args[0], 'dl/PLAF203/feeder/device/event/sub')
        payload = json.loads(call.args[1])
        self.assertEqual(payload['msgId'], 'request-id')
        self.assertEqual(payload['cmd'], 'GET_FEEDING_PLAN_EVENT')
        self.assertEqual(payload['code'], 0)
        self.assertCountEqual(payload['plans'], CAPTURED['GET_FEEDING_PLAN_EVENT'])

    async def test_real_event_dispatch_passes_message_id(self):
        request = {'cmd': 'GET_FEEDING_PLAN_EVENT', 'msgId': 'actual-id', 'ts': 1}
        with patch.object(devices, '_device_name', return_value='Feeder'), \
                patch.object(devices, '_respond_feeding_plan', AsyncMock()) as respond:
            topic = 'dl/PLAF203/feeder/device/event/post'
            devices._handle_message('feeder', topic, json.dumps(request))
            import asyncio
            await asyncio.sleep(0)
            respond.assert_awaited_once_with('feeder', topic, 'actual-id')

    async def test_local_flags_and_expired_skip_are_not_sent(self):
        self.plans[0].update(_enabled=False)
        self.plans[1].update(label='Dinner', _local=True, skipEndTime=1)
        wired = devices._wire_plans(self.plans, camera_feeder=True, service_push=True)
        self.assertEqual(len(wired), 1)
        for key in ('_enabled', '_local', 'label', 'skipEndTime'):
            self.assertNotIn(key, wired[0])
        self.assertEqual(wired[0]['syncTime'], self.plans[1]['syncTime'])

    async def test_paused_schedule_sends_empty_list(self):
        self.storage.schedules_paused = lambda _: True
        with patch.dict(sys.modules, {'storage': self.storage}):
            await devices.send_feeding_plans('feeder', self.plans)
        self.assertEqual(json.loads(devices._client_ref.publish.await_args.args[1])['plans'], [])

    def test_other_feeders_do_not_get_plaf203_padding(self):
        expected = sorted(self.plans, key=lambda plan: plan['executionTime'])
        self.assertEqual(devices._wire_plans(self.plans), expected)
