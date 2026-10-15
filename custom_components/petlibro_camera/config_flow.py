from homeassistant.config_entries import ConfigFlow

from .const import DOMAIN


class PetlibroCameraConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")
        return self.async_create_entry(title="Petlibro Local - Live Camera Bridge", data={})
