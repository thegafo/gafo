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
var registeredScripts  = {};

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

      // when a new call is inserted
      observer.added = function(id, newValue) {

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
