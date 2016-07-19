#!/usr/bin/env node --harmony

var exec = require('child_process').exec;
var clear = require('clear');
var co = require('co');
var prompt = require('co-prompt');
var program = require('commander');
var ddp = require('ddp');
var login = require('ddp-login');
var fs = require('fs');
var util = require('util')

var slaveConfiguration = {};
var registeredSlave  = {};

// establish DDP connection
var ddpClient = new ddp({
  //host: "g.gafo.us",
  //port: 80
  host: "localhost",
  port: 3000
});

if (process.argv.length < 3) {
  console.log("Usage: gafo <config_filename>");
  process.exit(1);
}

program
  .arguments('<config_file>')
  .option('-u, --username <username>', 'The user to authenticate as')
  .option('-p, --password <password>', 'The user\'s password')
  .action(function(config_file) {

    if (!config_file) { console.log("Configuration file required."); process.exit(1); }

    var username = program.username;
    var password = program.password;

    // read configuration file
    fs.readFile(config_file, 'utf8', function (err1, data) {
      if (err1) {
        console.log("Error: invalid JSON for configuration");
        process.exit(1);
      }

      // attempt to parse into JSON
      try {
        var obj = JSON.parse(data);
      } catch (err2) {
        console.log("Error: configuration file could not be parsed");
        process.exit(1);
      }

      if (!obj) {
        return console.log("Error: invalid configuration file");
        process.exit(1);
      } else {
        clear();
        slaveConfiguration = obj;
        console.log("Configuration successful!");

        co(function *() {

          if (!username) username = yield prompt('username: ');
          if (!password) password = yield prompt.password('password: ');

          ddpClient.connect(function (err) {
            if (err) throw err;

            var sessionId = ddpClient.session;

            ddpClient.call("login", [
              { user : { username : username }, password : password }
            ], function (err, result) {
              if (err) {
                console.log("Unable to connect to Gafo.");
                console.log(err.message);
                process.exit(1);

              }

              var userId = result.id;

              clear();
              console.log("Connected to gafo! slaveId: " + sessionId);
              registerSlave(userId, sessionId, slaveConfiguration);
              scan("poweredOn");
            });

          });


        });

      }

    });





})
.parse(process.argv);



function registerSlave(userId, sessionId, slaveConfiguration) {
  ddpClient.call('registerSlave', [userId, sessionId, slaveConfiguration], function(err,result) {
    if (err) return console.log(err);

    if (result == false) console.log("Error registering slave.");

    registeredSlave = result;

  });
  subscribeToSlaveData(userId, sessionId);
  pulse(userId, sessionId);
}

function subscribeToSlaveData(userId, slaveId) {
  ddpClient.subscribe(
    'slave',
    [slaveId],
    function () {
      //console.log('subscribed to slave data');
      var observer = ddpClient.observe("slaves");

      // observe slave data
      observer.removed = function(id, oldValue) {
        if (oldValue._id == slaveId) {
          console.log("session closed from dashboard");
          process.exit(1);
        }
      };
    }
  );

  ddpClient.subscribe(
    'slave_scripts',
    [slaveId],
    function () {
      //console.log('subscribed to script data');
      var observer = ddpClient.observe("scripts");
      // SHOULDNT CHANGE
      observer.added = function(id, newValue) {};
      observer.changed = function(id, oldFields, clearedFields, newFields) {};
    }
  );

  ddpClient.subscribe(
    'slave_peripherals',
    [slaveId],
    function () {
      //console.log('subscribed to peripheral data');
      var observer = ddpClient.observe("peripherals");
      console.log("subscribed to peripherals")
      // SHOULDNT CHANGE
      observer.added = function(id, newValue) {
      };
      observer.changed = function(id, oldFields, clearedFields, newFields) {
      };
    }
  );

  ddpClient.subscribe(
    'slave_calls',
    [slaveId],
    function () {
      var observer = ddpClient.observe("calls");

      // SCRIPT OR PERIPHERAL CALL?


      // when a new call is inserted
      observer.added = function(id, newValue) {
        
        if (newValue.peripheralId) {
          console.log("THIS IS A PERIPHERAL CALL");
          sendToPeripheral(peripherals[registeredSlave.peripherals[newValue.peripheralId]], newValue.message);
        
        }

        if (newValue.scriptId) {

         console.log("THIS IS A SCRIPT CALL");

         var scriptName = registeredSlave.scripts[newValue.scriptId];

          // get function data
          var script = slaveConfiguration.scripts[scriptName];

          // get any parameters passed in call
          var parameters = newValue.parameters || false;

          //TODO validate parameters

          // if script does not exist
          if (!script) {
            var statement = "ERROR: script " + scriptName + " not found."
            console.log(statement);
            ddpClient.call('addToCallResult', [id, {stderr: statement}]);

          // if function exists
          } else {

            var command = script.execute;
            if (parameters) {
              command += " '" + JSON.stringify(parameters) + "'"
            }
            console.log("Executing: " + command);

            // execute script
            exec(command, function(error, stdout, stderr) {
              console.log(stdout);
              ddpClient.call('addToCallResult', [id, {stderr: stderr, stdout: stdout, date: new Date()}]);
            });
          }
        }

      };
    }
  );
}

function pulse(userId, sessionId) {
  ddpClient.call('pulse', [userId, sessionId], function(err,result){
    if (err) return console.log(err);

    // if slave is dead (server returns false if slave does not exist)
    if (result == false) return;

    setTimeout(function(){
      pulse(userId, sessionId);
    }, 10000);

  });
}




///////////////////// BLE PORTION
// TODO extend to it's own package?


var noble = require('noble');
var moment = require('moment');


var found_peripherals = [];
var found_peripheral_uuids = [];
var connected = [];
var connections = {};

var lastPeripheralConnect = {};

var peripherals = {};
var services_discovered = {};
var characteristics_discovered = {};

var writeCharacteristics = {}; // key is peripheral id, value is write characteristic

//noble.on('stateChange', scan);

function scan(state) {
  if (state === "poweredOn") {
    noble.startScanning([], false); // scan for all devices, no duplicates
    setTimeout(function() {
      noble.stopScanning();
      scan(state);
    }, 6000);
  } else {
    noble.stopScanning();
    console.log("Bluetooth may be off");
  }
}


noble.on('discover', function(peripheral) {
  // if peripheral in confg
  if (peripheral.uuid in slaveConfiguration["peripherals"]) {
    console.log("peripheral found " + peripheral.uuid);
    connectToPeripheral(peripheral);
    peripherals[peripheral.uuid] = peripheral;
  }

});


function connectToPeripheral(peripheral) {
  peripheral.disconnect(); // test to see if this fixes buginess
  peripheral.connect( function(err) {
    if (err) return console.log(err);
    console.log(peripheral.uuid + " attempting connection");
    discoverServices(peripheral);
  });

  peripheral.on('disconnect', function() {
    services_discovered[peripheral.uuid] = false
    characteristics_discovered[peripheral.uuid] = false
  });
  return;
}

function discoverServices(peripheral) {
  peripheral.discoverServices([], function(err, services) {
    if (err) return console.log(err);
    if (services_discovered[peripheral.uuid]) return console.log("services already discovered");
    console.log('\n');
    services_discovered[peripheral.uuid] = true;
    connectToService(peripheral, services);
  });

}

function connectToService(peripheral, services) {
 console.log("connecting to service ", peripheral.uuid);
  for (s in services) {
    if (services[s].uuid == slaveConfiguration["peripherals"][peripheral.uuid]["service_uuid"]) {
      console.log("service match");
      return discoverCharacteristics(peripheral, services[s]);
    }
  }
  console.log("service not found");
  peripheral.disconnect();
}

function discoverCharacteristics(peripheral, service) {
  service.discoverCharacteristics([], function(err, characteristics) {
    if (err) return console.log(err);
    if (characteristics_discovered[peripheral.uuid]) return console.log("characteristics already discovered");
    characteristics_discovered[peripheral.uuid] = true;

    // connect to read characteristic
    if (slaveConfiguration["peripherals"][peripheral.uuid]["read_characteristic_uuid"])
      connectToReadCharacteristic(peripheral, characteristics);
    else
      console.log("read characteristic uuid not set");

    // connect to write characteristic
    if (slaveConfiguration["peripherals"][peripheral.uuid]["write_characteristic_uuid"])
      connectToWriteCharacteristic(peripheral, characteristics);
    else
      console.log("write characteristic uuid not set");
  });
}


function connectToReadCharacteristic(peripheral, characteristics) {
  console.log("connecting to read characteristic ", peripheral.uuid);
  for (c in characteristics) {
    if (characteristics[c].uuid == slaveConfiguration["peripherals"][peripheral.uuid]["read_characteristic_uuid"]) {
      console.log("characteristic match");
      characteristics[c].subscribe(function(err) {
        if (err) return console.log(err);
        console.log("subscribed to characteristic!");
      });
      characteristics[c].on("data", function (data, isNotification) {
        var message = slaveConfiguration["peripherals"][peripheral.uuid]["name"] + " [" + moment().format("DD/MMM/YY:HH:mm:ss") + "] \"" + data + "\"";
        console.log(message);
        // get registered id
        var registeredId = false;
        for (i in registeredSlave.peripherals) {
          if (registeredSlave.peripherals[i] == peripheral.uuid) registeredId = i;
        }
  
        if (!registeredId) return console.log("REGISTERED ID NOT FOUND");

        ddpClient.call('logPeripheralRead', [registeredId, "" + data], function(err,result){ //sessionId is slaveId
          if (err) return console.log(err);

          // if slave is dead (server returns false if slave does not exist)
          if (result == false) return;

        });
      });
      return;
    }
  }
  console.log("characteristic not found");
  peripheral.disconnect();

}

function connectToWriteCharacteristic(peripheral, characteristics) {
  console.log("connecting to write characteristic ", peripheral.uuid);
  for (c in characteristics) {
    if (characteristics[c].uuid == slaveConfiguration["peripherals"][peripheral.uuid]["write_characteristic_uuid"]) {
      console.log("write characteristic match!");
      // TODO write to characteristic
      writeCharacteristics[peripheral.uuid] = characteristics[c];
      //blink(peripheral);
      //sendToPeripheral(peripheral, '0');
      return;
    }
  }
  console.log("characteristic not found");
  peripheral.disconnect();

}

function blink(peripheral) {
  sendToPeripheral(peripheral, '1');
  setTimeout(function() {
    sendToPeripheral(peripheral, '0');
  }, 5000);
  setTimeout(function() {
    blink(peripheral);
  }, 10000);
}



function sendToPeripheral(peripheral, message) {
  console.log("Attempting to send message to peripheral: " + message);
  console.log(peripheral.uuid);
  if (peripheral.uuid in writeCharacteristics) {
    writeCharacteristics[peripheral.uuid].write(new Buffer(message), false, function(err) {
      if (err) return console.log(err);
      console.log("wrote to characteristic");
    })
  } else {
    console.log("peripheral not connected");
  }
}

