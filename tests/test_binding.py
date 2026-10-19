"""Cloud-captured PLAF203 binding reply and onboarding eligibility."""
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location('binding_test_devices', Path(__file__).parents[1] / 'addon/app/devices.py')
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'aiomqtt': Mock(), 'ha_mqtt': Mock(), 'device_types': Mock()}), \
        patch('logging.handlers.RotatingFileHandler', return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)

SERIAL = 'AF0301310009FF402660JY'
TOPIC = f'dl/PLAF203/{SERIAL}/device/system/post'
REQUEST = {'cmd': 'BINDING', 'msgId': SERIAL + '1792349615000', 'type': 1,
           'pid': 'PLAF203', 'ts': 1792349615000}


class BindingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        devices._devices.clear()
        devices._pending_bindings.clear()
        devices._reconnect_event = asyncio.Event()
        self.client = Mock(publish=AsyncMock())

    async def test_captured_cloud_reply_for_configured_feeder(self):
        devices._devices[SERIAL] = ('PLAF203', 'camera_feeder')
        with patch.object(devices.time, 'time', return_value=1792349616.305):
            self.assertTrue(await devices._respond_binding(self.client, TOPIC, json.dumps(REQUEST)))
        call = self.client.publish.await_args
        self.assertEqual(call.args[0], TOPIC.removesuffix('post') + 'sub')
        self.assertEqual(json.loads(call.args[1]), {
            'cmd': 'BINDING', 'ts': 1792349616305, 'msgId': REQUEST['msgId'], 'code': 0, 'bindId': 15,
        })
        self.assertFalse(call.kwargs['retain'])

    async def test_newly_captured_feeder_can_bind_before_ui_save_and_retry(self):
        devices.expect_binding(SERIAL)
        self.assertTrue(devices._reconnect_event.is_set())
        for _ in range(2):
            self.assertTrue(await devices._respond_binding(self.client, TOPIC, json.dumps(REQUEST)))
        self.assertEqual(self.client.publish.await_count, 2)
        self.assertNotIn(SERIAL, devices._devices)

    async def test_unrelated_or_expired_feeder_is_not_bound(self):
        self.assertFalse(await devices._respond_binding(self.client, TOPIC, json.dumps(REQUEST)))
        devices._pending_bindings[SERIAL] = 1
        self.assertFalse(await devices._respond_binding(self.client, TOPIC, json.dumps(REQUEST)))
        self.client.publish.assert_not_awaited()

    async def test_mqtt_loop_answers_binding_with_no_saved_devices(self):
        devices.expect_binding(SERIAL)
        client = Mock(subscribe=AsyncMock(), publish=AsyncMock())
        async def messages():
            yield SimpleNamespace(topic=TOPIC, payload=json.dumps(REQUEST).encode())
            raise asyncio.CancelledError
        client.messages = messages()
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(devices.aiomqtt, 'Client', return_value=context), \
                patch.object(devices.aiomqtt, 'MqttError', RuntimeError), \
                patch.dict(sys.modules, {'storage': Mock()}):
            with self.assertRaises(asyncio.CancelledError):
                await devices._mqtt_loop()
        client.subscribe.assert_awaited_once_with('dl/#')
        self.assertEqual(client.publish.await_args.args[0], TOPIC.removesuffix('post') + 'sub')
        self.assertEqual(json.loads(client.publish.await_args.args[1])['bindId'], 15)

    async def test_bad_topic_or_request_cannot_trigger_binding(self):
        devices.expect_binding(SERIAL)
        cases = [
            (TOPIC.replace('/post', '/sub'), REQUEST),
            (TOPIC.replace('PLAF203', 'PLAF103'), REQUEST),
            (TOPIC.replace('/system/', '/event/'), REQUEST),
            (TOPIC, {'cmd': 'ATTR_GET_SERVICE', 'msgId': 'example'}),
            (TOPIC, {'cmd': 'BINDING'}),
            (TOPIC, {'cmd': 'BINDING', 'msgId': 42}),
            (TOPIC, []),
        ]
        for topic, payload in cases:
            with self.subTest(topic=topic, payload=payload):
                self.assertFalse(await devices._respond_binding(self.client, topic, json.dumps(payload)))
        self.assertFalse(await devices._respond_binding(self.client, TOPIC, 'invalid json'))
        self.client.publish.assert_not_awaited()

    async def test_publish_failure_is_not_reported_as_success(self):
        devices.expect_binding(SERIAL)
        self.client.publish.side_effect = RuntimeError('offline')
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            await devices._respond_binding(self.client, TOPIC, json.dumps(REQUEST))
