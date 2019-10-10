"use strict";
var Service, Characteristic;
var waitUntil = require('wait-until');
var pollingtoevent = require("polling-to-event");

var pjson = require('./package.json');
var risco = require('./risco');

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-risco-alarm", "RiscoAlarm", RiscoSecuritySystemAccessory);
}

function translateState(aState) {
    // 0 -  Characteristic.SecuritySystemTargetState.STAY_ARM: => Partial Mode
    // 1 -  Characteristic.SecuritySystemTargetState.AWAY_ARM: => Full Armed Mode
    // 2-   Characteristic.SecuritySystemTargetState.NIGHT_ARM: => Partial Mode
    // 3 -  Characteristic.SecuritySystemTargetState.DISARM: => Really ?? Disarmed
    var translatedSate = "UNKNOWN";

    switch (aState) {
        case Characteristic.SecuritySystemTargetState.STAY_ARM:
            translatedSate = "STAY_ARM";
            break;
        case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
            translatedSate = "NIGHT_ARM";
            break;
        case Characteristic.SecuritySystemTargetState.AWAY_ARM:
            translatedSate = "AWAY_ARM";
            break;
        case Characteristic.SecuritySystemTargetState.DISARM:
            translatedSate = "DISARM"
            break;
        case 4:
            translatedSate = "ALARM"
            break;
    };

    return translatedSate
}

function RiscoSecuritySystemAccessory(log, config) {

    this.log = log;
    this.debuglogging = config["debuglogging"] || 0; // 0 = state logging, 1 = some debug logging, 2 = all debug logging
    this.name = config["name"];
    this.riscoUsername = config["riscoUsername"];
    this.riscoPassword = config["riscoPassword"];
    this.riscoPIN = config["riscoPIN"];
    this.polling = config["polling"] || false;
    this.pollInterval = config["pollInterval"] || 30000;
    this.homeCommand = config["homeCommand"] || "partially";
    this.armCmd = config["armCommand"] || "armed";
    this.partialCommand = config["partialCommand"] || "partially";
    this.disarmCmd = config["disarmCommand"] || "disarmed";
    this.riscoSiteId = config["riscoSiteId"];
    this.riscoPartId = config["riscoPartId"] || 0;
    this.riscoPartMode = config["riscoPartMode"] || false;

    this.long_event_name = 'long_' + (this.name.toLowerCase()).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ /g, '_');
    // Default Value
    this.riscoCurrentState;// = 3; // Do not set default. Looks like plugin get restarted after some time. Generates false alarms.

    var self = this;

    this.RiscoPanel = new risco.RiscoPanelSession(this.riscoUsername, this.riscoPassword, this.riscoPIN, this.riscoSiteId,  this.riscoPartMode, this.riscoPartId, this.log, this.debuglogging);

    // set up polling if requested
    if (self.polling) {
        if (self.debuglogging >= 1) {
            self.log("Starting polling with an interval of %s ms", self.pollInterval);
        }
        var emitter = new pollingtoevent(function (done) {
            self.getRefreshState(function (err, result) {
                done(err, result);
            });
        }, {
                longpollEventName: self.long_event_name,
                longpolling: true,
                interval: self.pollInterval
            });

        emitter.on(self.long_event_name, function (state) {
            if (state) {
                // Get OnceMore time Current State:
                if (self.debuglogging >= 0) {
                    self.log('New state detected: (' + state + ') -> ' + translateState(state) + '. Notify!');
                }
                self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, state);
                self.riscoCurrentState = state;
            }
        });

        emitter.on("err", function (err) {
            if (self.debuglogging >= 1) {
                self.log("Polling failed, error was %s", err);
            }
        });
    }
}

RiscoSecuritySystemAccessory.prototype = {

    setTargetState: function (state, callback) {
        var self = this;

        if (self.debuglogging >= 0) {
            self.log("Setting state to %s", translateState(state));
        }
        var riscoArm;
        var cmd;

        switch (state) {
            case Characteristic.SecuritySystemTargetState.STAY_ARM:
                // stayArm = 0
                riscoArm = true;
                cmd = self.homeCommand;
                break;
            case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                // stayArm = 2
                riscoArm = true;
                cmd = self.partialCommand;
                break;
            case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                // stayArm = 1
                riscoArm = true;
                cmd = self.armCmd;
                break;
            case Characteristic.SecuritySystemTargetState.DISARM:
                // stayArm = 3
                riscoArm = false
                cmd = self.disarmCmd;
                break;
        };
        self.RiscoPanel.arm(riscoArm, cmd).then(function (resp) {
            self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, state);
            self.riscoCurrentState = state;
            callback(null, self.riscoCurrentState);
        }).catch(function (error) {
            // Most propably user not logged in. Re-login
            // First Logout by security
            self.RiscoPanel.logout()
            self.RiscoPanel.login().then(function (resp) {
                //successful call
                if (self.debuglogging >= 1) {
                    self.log('Relogin success...continue to set new Risco Status');
                }
                self.RiscoPanel.arm(riscoArm, cmd).then(function (resp) {
                    self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, state);
                    self.riscoCurrentState = state;
                    callback(null, state);
                }).catch(function (error) {
                    self.log(error)
                    callback(null, self.riscoCurrentState);
                });
            }).catch(function (error) {
                self.log(error);
                callback(null, self.riscoCurrentState);
            });
        });
    },

    getState: function (callback) {
        var self = this;
        self.RiscoPanel.login().then(function (resp) {
            self.RiscoPanel.getCPState().then(function (resp) {
                // Worked.
                if (resp == 'true') {
                    // Return Alarm is Going Off
                    if (self.debuglogging >= 0) {
                        self.log("Actual state is: (" + resp + ") -> ", translateState(resp));
                    }
                    self.riscoCurrentState = 4;
                    callback(null, self.riscoCurrentState);
                } else {
                    self.RiscoPanel.getState().then(function (resp) {
                        // Worked.
                        if (resp == 0 || resp == 1 || resp == 2 || resp == 3) {
                            if (self.debuglogging >= 0) {
                                self.log("Actual state is: (" + resp + ") -> ", translateState(resp));
                            }
                            self.riscoCurrentState = resp;
                            callback(null, self.riscoCurrentState);
                        }
                    }).catch(function (error) {
                        if (self.debuglogging >= 2) {
                            self.log('Get State Failed', error);
                        }
                        //callback(null, self.riscoCurrentState);
                        callback("error");
                    });
                }
            }).catch(function (error) {
                if (self.debuglogging >= 2) {
                    self.log('Get CPState Failed', error);
                }
                callback(null, self.riscoCurrentState);
                return
            });
        }).catch(function (error) {
            if (self.debuglogging >= 1) {
                self.log('Login failed', error);
            }
            callback(null, self.riscoCurrentState);
            return
        });
    },

    getCurrentState: function (callback) {
        var self = this;
        if (self.polling) {
            callback(null, self.riscoCurrentState);
        } else {
            if (self.debuglogging >= 1) {
                self.log('Getting current state - delayed...');
            }
            waitUntil()
                .interval(500)
                .times(15)
                .condition(function () {
                    return (self.riscoCurrentState ? true : false);
                })
                .done(function (result) {
                    // do stuff
                    self.RiscoPanel.login().then(function (resp) {
                        self.RiscoPanel.getState().then(function (resp) {
                            // Worked.
                            if (resp == 'true') {
                                // Return Alarm is Going Off
                                if (self.debuglogging >= 0) {
                                    self.log('Actual state is: (' + resp + ') -> ', translateState(resp));
                                }
                                self.riscoCurrentState = 4;
                                self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, self.riscoCurrentState);
                                callback(null, self.riscoCurrentState);
                            } else if (resp == 0 || resp == 1 || resp == 2 || resp == 3) {
                                    // Worked.
                                    if (self.debuglogging >= 0) {
                                        self.log('get state Actual state is: (' + resp + ') -> ', translateState(resp));
                                    }
                                    self.riscoCurrentState = resp;
                                    self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, self.riscoCurrentState);
                                    callback(null, self.riscoCurrentState);
                            }
                        }).catch(function (error) {
                            if (self.debuglogging >= 1) {
                                self.log('Get CPState Failed', error);
                            }
                            self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, self.riscoCurrentState);
                            callback(null, self.riscoCurrentState);
                            return
                        });
                    }).catch(function (error) {
                        if (self.debuglogging >= 1) {
                            self.log('Login failed', error);
                        }
                        self.securityService.setCharacteristic(Characteristic.SecuritySystemCurrentState, self.riscoCurrentState);
                        callback(null, self.riscoCurrentState);
                        return
                    });
                    self.RiscoPanel.logout();
                });
        }
    },

    getTargetState: function (callback) {
        var self = this;
        if (self.polling) {
            callback(null, self.riscoCurrentState);
        } else {
            if (self.debuglogging >= 1) {
                self.log("Getting target state...");
            }
            self.getState(callback);
        }
    },

    getRefreshState: function (callback) {
        var self = this;
        self.RiscoPanel.getCPState().then(function (resp) {
            if (resp >= 0 || resp <= 4) {
                // Return Alarm is Going Off
                self.riscoCurrentState = resp;
            }
            callback(null, self.riscoCurrentState);
        }).catch(function (error) {
            if (self.debuglogging >= 1) {
                self.log('Sesion expired, relogin...');
            }
            self.RiscoPanel.logout();
            self.RiscoPanel.login().then(function (resp) {
                self.RiscoPanel.getCPState().then(function (resp) {
                    // Worked.
                    if (resp >= 0 || resp <= 4) {
                        self.riscoCurrentState = resp;
                    }
                    callback(null, self.riscoCurrentState);
                }).catch(function (error) {
                    if (self.debuglogging >= 1) {
                        self.log('Get CPState Failed', error);
                    }
                    callback(null, self.riscoCurrentState);
                    return
                });
            }).catch(function (error) {
                if (self.debuglogging >= 1) {
                    self.log('Login failed', error);
                }
                callback(null, self.riscoCurrentState);
                return
            });
        });
    },

    identify: function (callback) {
        if (self.debuglogging >= 2) {
            self.log('Identify requested!');
        }
        callback(); // success
    },

    getServices: function () {
        this.securityService = new Service.SecuritySystem(this.name);

        this.securityService
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .on('get', this.getCurrentState.bind(this));

        this.securityService
            .getCharacteristic(Characteristic.SecuritySystemTargetState)
            .on('get', this.getTargetState.bind(this))
            .on('set', this.setTargetState.bind(this));

        this.infoService = new Service.AccessoryInformation();
        this.infoService
            .setCharacteristic(Characteristic.Manufacturer, "Daniel S")
            .setCharacteristic(Characteristic.Model, this.name)
            .setCharacteristic(Characteristic.SerialNumber, pjson.version);

        return [this.infoService, this.securityService];
    }
};
