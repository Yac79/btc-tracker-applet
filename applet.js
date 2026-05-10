const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;

class BtcTrackerApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.metadata = metadata;
        this.instance_id = instance_id;

        this.set_applet_icon_path(this.metadata.path + "/icon.png");

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("currency", "currency", this.on_settings_changed.bind(this));
        this.settings.bind("refreshInterval", "refreshInterval", this.on_settings_changed.bind(this));

        this._session = new Soup.Session();
        this._session.timeout = 10;
        this._session.idle_timeout = 10;

        // Fixed User-Agent: often necessary to avoid 403 blocks on the Cloudflare/API side
        this._session.user_agent = "btc-tracker@ya3c/1.0";

        this._timerId = null;
        this._requestInFlight = false;
        this._lastGoodData = null;

        this._enableMarkup();
        this.update_price();
    }

    _enableMarkup() {
        if (this._applet_label) {
            let clutter = this._applet_label.get_clutter_text();
            if (clutter) {
                clutter.set_use_markup(true);
            }
        }
    }

    on_settings_changed() {
        this.update_price();
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _scheduleNextUpdate() {
        this._clearTimer();

        let minutes = Number(this.refreshInterval) || 5;
        let seconds = Math.max(60, minutes * 60);

        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            seconds,
            () => {
                this.update_price();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _buildUrl() {
        let curr = (this.currency || "USD").toLowerCase();
        return `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${curr}&include_24hr_change=true`;
    }

    _formatLabel(curr, price, change, stale = false) {
        let color = change >= 0 ? "#2ecc71" : "#ff4d4d";
        let sign = change > 0 ? "+" : "";
        let priceFormatted = Number(price).toLocaleString("it-IT", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        let text = `<span foreground="white">${curr.toUpperCase()}:</span> ` +
                   `<span foreground="${color}">${priceFormatted} (${sign}${change.toFixed(2)}%)`;

        if (stale) {
            text += " !";
        }

        text += `</span>`;
        return text;
    }

    _showFallbackOrError(message) {
        if (this._lastGoodData) {
            let label = this._formatLabel(
                this._lastGoodData.curr,
                this._lastGoodData.price,
                this._lastGoodData.change,
                true
            );
            this.set_applet_label(label);
            this._enableMarkup();
        } else {
            this.set_applet_label(message);
        }
    }

    update_price() {
        if (this._requestInFlight) {
            return;
        }

        this._clearTimer();
        this._requestInFlight = true;

        let curr = (this.currency || "USD").toLowerCase();
        let url = this._buildUrl();
        let message = Soup.Message.new("GET", url);

        message.request_headers.append("Accept", "application/json");
        message.request_headers.append("User-Agent", "btc-tracker@ya3c/1.0");

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    let status = message.get_status ? message.get_status() : message.status_code;

                    if (status < 200 || status >= 300) {
                        global.logWarning(`[btc-tracker] HTTP status: ${status}`);

                        if (status === 403) {
                            this._showFallbackOrError("API access denied");
                        } else if (status === 429) {
                            this._showFallbackOrError("Rate limit API");
                        } else {
                            this._showFallbackOrError(`Error HTTP ${status}`);
                        }

                        return;
                    }

                    let bytes = session.send_and_read_finish(result);
                    let decoder = new TextDecoder("utf-8");
                    let response = decoder.decode(bytes.get_data());

                    let data = JSON.parse(response);

                    if (data && data.bitcoin && data.bitcoin[curr] !== undefined) {
                        let price = Number(data.bitcoin[curr]);
                        let change = Number(data.bitcoin[curr + "_24h_change"] || 0);

                        this._lastGoodData = {
                            curr,
                            price,
                            change
                        };

                        let labelText = this._formatLabel(curr, price, change, false);
                        this.set_applet_label(labelText);
                        this._enableMarkup();
                    } else {
                        global.logWarning(`[btc-tracker] JSON unexpected: ${response}`);
                        this._showFallbackOrError("Invalid data");
                    }
                } catch (e) {
                    global.logError(`[btc-tracker] Error update_price: ${e}`);
                    this._showFallbackOrError("Errore JSON");
                } finally {
                    this._requestInFlight = false;
                    this._scheduleNextUpdate();
                }
            }
        );
    }

    on_applet_removed_from_panel() {
        this._clearTimer();

        if (this._session && this._session.abort) {
            this._session.abort();
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new BtcTrackerApplet(metadata, orientation, panel_height, instance_id);
}
