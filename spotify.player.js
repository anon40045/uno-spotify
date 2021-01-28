#!/usr/local/bin/node
'use strict'; 
/*
	Spotify Player

	This is a "player"-module that will play Spotify. It requires a spotify premium account


	It runs a spotifyd daemon (which is built on librespot) which outputs music to a named pipe and
	can be controlled via spotify connect and MPRIS (which is a dbus protocol for remote control of
	media players)
		https://github.com/Spotifyd/spotifyd
		https://github.com/librespot-org/librespot
		https://specifications.freedesktop.org/mpris-spec/latest/
		https://dbus.freedesktop.org/doc/dbus-tutorial.html
		https://www.npmjs.com/package/mpris


	To search for tracks we use Spotify's own developer api:
		https://developer.spotify.com/console/get-search-item/



	NOTE: This module exports a constructor that should be new:ed



	2018-10-04: Something breaks when  no "spotify connect" is connected... commands don't work etc... we 
				may have to get a connect client that pings the userObj.process....

*/
module.exports = SpotifyPlayer;


//2018-10-22: For now just use these temp var's, but it's really setup by config file and we should read from there....
var DEFAULT_USER='ellenostberg';



const {h,fsX,cpX}=require(process.env.Q_DIR_LIB+'/util/util.node.js');
const es=require('event-stream');

/*
* @const object es 		Used to read a stream line by line
*							https://www.npmjs.com/package/event-stream
*/



const scrape=require(__dirname+'/spotify.scrape.js');




// The 3 levels of DBus nameing/addressing for the MPRIS standard, see 
//		https://doc.qt.io/qt-5/qtdbus-index.html
// 		https://specifications.freedesktop.org/mpris-spec/latest/#Interfaces
var dbus={
	lvl1_ServiceName:'org.mpris.MediaPlayer2.spotifyd'
	,lvl2_ObjectPath:'/org/mpris/MediaPlayer2'
	,lvl3_InterfaceDefault:'org.mpris.MediaPlayer2.Player'
}



var logfile_base='/var/log/musicdaemon/spotifyd.XXX.log';







function SpotifyPlayer(){

	global.init.Player(this,
		{
			'simultaneousPlay':false //ie. only one stream can be fetched at a time (cache or play, then get next)
			,'infinitLibrary':true //ie. the library listings don't contain all possible files
			,'online':true
			,'basicFolders':[
				'/Users'
				,'/Featured playlists'
			]
			,'rootFolder':'Spotify'
		}
		,{
			fifoDir:{type:'string',value:'/tmp/spotify-fifos'}
		}
	);

	var self=this;

	//Private variable to hold all private properties... for clarity
	/*
	* @var object 	_private 	Object to hold all private properties on SpotifyPlayer, used for clarity.
	*			
	* NOTE: All private props defined from now on should be set on this object
	*
	* @access pricate
	*/
	var _private={};

	


	/*
	* @var object 	daemons 		Keys are user names, values are child objects holding config and the
	*								actual spotifyd child processes
	* @access private
	*/
	_private.daemons={
		'ellenostberg':{
			process:null
			,configFile:__dirname+'/spotifyd.config'
		}
	};

	startDaemon(DEFAULT_USER)
		.catch(console.error);



	/*
	* @var string nowPlaying 	Title of currently playing song, or 'spotify:connect' or null if nothing is playing
	* @access private
	*/
	_private.nowPlaying=null;

	/*
	* @var object cats 	Keys are users, values are their currently running cat processes of their respective fifos. 
	*					Set by getStream() and stopped by stopCurrent()
	* @access private
	*/
	_private.cats={};


	/*
	* Check if this player can play a certain uri
	*
	* @param string uri 	The uri we're trying to play
	*
	* @throws Error 		If this player normally handles this type of uri, but there's something wrong with
	*						this particular one (eg. it doesn't exist or we don't have permission to play it)
	*
	* @return bool 	
	*/
	this.canPlayUri=function(uri){

		uri=cX.trim(uri,true) //true==throw on fail

		try{
			scrape.parseUriUrl(uri)
			return true;
		}catch(err){
			// self.log.error('FAILED:',uri, err);
			//Not a valid spotify uri/url
			return false;
		}

	}




	/*
	* @return Promise 	Resolved with <TrackObj> or <ListObj>
	*/
	this.getUriDetails=function(uri){
		return scrape.getUriDetails(uri)
			.then(info=>{
				switch(info.type){
					case 'track':
						return new global.class.TrackObj(info);
					case 'user':
					case 'album':
						var folder=`/Spotify/${cX.firstToUpper(info.type)}s/${info.title}`
						return global.class.ListObj.createFolder(folder,info.contents);
					case 'playlist':
						return new global.class.ListObj(info);
				}
			})
		;
	}
	// (uri)=>{
	// 	uri=cX.trim(uri,true) //true==throw on fail

	// 	if(uri=='spotify:connect')
	// 		return new TrackObj(Object.assign({
	// 			uri:uri
	// 			,title:'Spotify connect ('+DEFAULT_USER+')'
	// 			,infinit:true
	// 		},outputOptions));

	// 	return scrape.getUriDetails(uri)
	// 		.then(info=>{
	// 			if(info.type=='track'){
	// 				return new TrackObj(Object.assign(info,outputOptions));
	// 			}else{
	// 				return new ListObj(info);
	// 			}
	// 		})
	// 	;
	// }


	/*
	* Can be called when resuming, but also to make sure playback happens here instead of
	* some other spotify-connect speakers...
	*/
	function play(){
		dbusCmd(dbus.lvl3_InterfaceDefault+'.Play');
	}
	var pause=function(){
		if(_private.nowPlaying)
			dbusCmd(dbus.lvl3_InterfaceDefault+'.Pause');
		else
			self.log.info("Already buffered/cached, no need to pause in player");
	}
	var resume=function(){
		if(_private.nowPlaying)
			play();	
		else
			self.log.info("Already buffered/cached, no need to resume in player");
	}

	/*
	* Get a stream for a uri that can be passed to an output
	*
	* @param <TrackObj> tObj 
	*
	* @return Promise(<ChildProcess>,err)
	*/
	this.getStream=function(tObj){
		if(!cX.instanceOf(global.class.TrackObj,tObj,true)) //true=>return false on bad type
			return Promise.reject('Expected <TrackObj>, got: '+cX.logVar(tObj));

		var uri=tObj.uri;
		self.log.info("getStream()",uri);

		//First explicitly make sure the daemon is running, just so we're explicit...
		return ensureDaemonRunning(DEFAULT_USER)
			.then(()=>stopCurrent(DEFAULT_USER)) //stop potentially playing track
			.then(()=>{

				// self.log.info("cat'ing fifo and creating new streamObj");
				//Start cat'ing the fifo before we play the song, to make sure we get everything...
				var child=cpX.native.spawn('cat', [_private.daemons[DEFAULT_USER].fifo]);
				_private.cats[DEFAULT_USER]=child;
				// var sObj= new StreamObj(_private.cats[DEFAULT_USER], playbackOptions);
				// var sObj= new StreamObj(_private.cats[DEFAULT_USER], tObj);

	// NOTE: If you're having PROBLEMS with NO SOUND, its most likely conflict between multiple instances of spotify... 	

				//If we're listening to spotify:connect, just continue, else tell the daemon to start playing, 
				//continuing even if there's a problem
				if(uri=='spotify:connect'){
					self.log.info("Listening to spotify:connect, ie. just cat'ing fifo...");
					_private.nowPlaying=uri;
					
					//Set pause/resume functions on stream so pausing will be reflected in other spotify clients 
					// sObj.setPauseResume(pause,resume);
					child._pause=pause;
					child._resume=resume;
					child._stop=stopCurrent.bind(this,DEFAULT_USER);

				}else{
					// self.log.info("playing track",info.uri);
					dbusCmd(dbus.lvl3_InterfaceDefault+'.OpenUri', 'string:'+uri)
						.catch(err=>self.log.error("Failed to send DBus command: ",err))
					;
				//PROBLEM: Unless spotify is open in phone/browser and "output" is set to this instance,
				//			no sound will come...
					play();
				}


				// return sObj;
				return child;
			})
			
		;

	}






//TODO: we should just be able to use the func from the streamObj
	/*
	* Make sure this player is not playing anything, stopping it if that's the case
	*
	* @return Promise 	Resolves when nothing is playing, else rejects
	*/
	function stopCurrent(user){

	//2018-10-23: Shouldn't need this, it's done in onFinish()
		// //Reset nowPlaying regardless...
		// _private.nowPlaying=null;

		//For good meassure tell spotify to pause playing (I don't think spotify supports 'stop'... nothing
		//seems to happen...)
		dbusCmd(dbus.lvl3_InterfaceDefault+'.Pause')

		//If we have a stream going...
		if(_private.cats[user])
			//... just use its stop method, and on success remove it from here...
			return cpX.killPromise(_private.cats[user], 'SIGTERM',2000,true) //true --> SIGKILL after 2000 ms
				.then(success=>_private.cats[user]=null)
			;
		else
			//For now just return a resolved promise if there's no stream
			return Promise.resolve(true);
	}


	function killSingleDaemon(user){

		return new Promise((resolve,reject)=>{
			let u=_private.daemons[user];

			//If the daemon is running, kill it
			if(cpX.childStatus(u.process)!='not_running'){
				self.log.info("Stopping spotifyd daemon for ",user,"...");

				cpX.killPromise(u.process,'SIGTERM',3000,true) //try SIGTERM, then SIGKILL after 3 seconds
				.then(
					success=>{
						self.log.info("Stopped spotifyd daemon for "+user);
						u.process=null;
						resolve('shutdown');
					}
					//let error propogate without null'ing daemon_process
				)
			}else{
				self.log.info("Daemon for ",user," not running...");
				resolve('not_running');
			}
		
		})
	}

	/*
	* @return Promise(undef, n/a)
	*/
	function killAllDaemons(){
		return cpX.execFileInPromise('pkill',['spotifyd'])
			.then(
				success=>self.log.info('Killed one or more running instances')
				,err=>self.log.info("No instances where running, nothing was killed")
			)
	}


	// this.shutdown=function(){
	// global.shutdown.register('Controller',function shutdownSpotify(){
	this.shutdown=function shutdownSpotify(){
		self.log.info('Killing daemons for users: ',Object.keys(_private.daemons).join())
		//Issue kill orders for all daemons
		var allKillPromises=[], user;
		for(user of Object.keys(_private.daemons)){
			allKillPromises.push(killSingleDaemon(user));
		}

		//Wait for them to return, and if any fail...
		return cX.groupPromises(allKillPromises).promise
			.catch(function spotifyShutdownFailed(obj){
				//Log all rejected killings...
				for(let err of obj.rejected){self.log.error(err)}
					
				//...KILL ALL
				self.log.error("Failed to kill all daemons, pkill'ing spotifyd...");
				return killAllDaemons()
					.catch(err=>self.log.error("Failed pkill'ing too. Nothing more to do!",err))
			})
	}
	// );

	function restartDaemon(user){
		return killSingleDaemon(user).then(
			success=>{
				return startDaemon(user);
			}
			,err=>{
				self.log.error(err);
				throw new Error('Could not stop old instance, so cannot restart new one')
			}
		)
	}

	
	/*
	* Make sure daemon is running, else try to start it
	*
	* @param string user
	*
	* @return Promise(null,err) 	Rejects if we couldn't get daemon started
	*/
	function ensureDaemonRunning(user){
		if(cpX.childStatus(_private.daemons[user].process)!='running')
			return startDaemon(user)
				.catch(err=>{
					self.log.error(err);
					throw new Error("spotifyd daemon is not running and failed to start");
				})
			;
		else
			return Promise.resolve(null);
	}

	async function startDaemon(user){
	//2018-10-23: Seems the daemon is often not killen when exiting... not good... for now
	// 			  kill all instances of it here. When we have multiple instances in the future
	//			  we'll need to handle somehow...
		await killAllDaemons();
		

		//First make sure the process isn't already running
		var userObj=_private.daemons[user];
		if(userObj.process){
			self.log.error(+"_private.daemons["+user+"].process: \n",userObj.process)
			throw new Error("Cannot start daemon because it may already be running, see console");
		}

		//Then makes sure we have a fifo
			//Check the directory exists
			var dir=self.settings.fifoDir.value+'/';
			fsX.mkdir(dir) //will leave untouched if already exists //throws on error

			//Re-create the fifo so we're sure it's empty...
			userObj.fifo=dir+user;
			fsX.createFifo(userObj.fifo,true) //true==recreate, //throws on error
			self.log.info("Using fifo: ",userObj.fifo)


		var cliOptions=[
			'-c',userObj.configFile
			,'--device',userObj.fifo
			,'--no-daemon' //so we can control it here in node
			,'--verbose' 
		];

		userObj.process=cpX.native.spawn('spotifyd', cliOptions); //spotifyd is symlinked to /usr/bin so it exists in PATH
														 //daemon is defined at top of class function ^^

		//Since we're not demonizing the process we'll get all log output on stdout. Before we send this to a logfile
		//we want to parse it for certain eventsNow define some events that will be emitted based on the log output
		userObj.process.stdout
			.pipe(es.split()) //split into lines
			.pipe(es.map((line,next)=>{
				//Check each line for the 4 events we care about, in the order they're most likely to occur so 
				//we save a liiiiiitle bit of effort...
				if(line.match(/\[INFO\]/)){
					let m,n;
					if((m=line.match(/"PLAYER_EVENT": "(\w+?)"/)) && (n=line.match(/"TRACK_ID": "(.+?)"/))){
						let uri='spotify:track:'+n[1]
						switch(m[1]){
							case 'start':
								onStart(uri,user); break;
							case 'stop':
								onFinish(uri,user); break;
							default:
								self.log.warn('UNHANDLED playback event: ',m[1]);
						}
					}
					
					else if(line.match(/Authenticated as/))
						//Just make sure the process is still running... i donno, just because...
						if(cpX.childStatus(userObj.process)!='not_running'){
							self.log.info("Successfully started daemon and logged in");
							userObj.process.emit('logged_in');
						}

					// self.log.info(m);
				}else if(line.match(/\[WARN\]/)){
					// self.log.warn(line); ///2018-10-23: Not much we can do with these..., just annoyting

				}else if(line.match(/\[ERROR\]/))
					if(cpX.childStatus(userObj.process)=='not_running')
						self.log.error("-FATAL-",line);
					else
						self.log.error(line);
				
				

				//Pass the line down the pipe
				next(null,line+'\n'); //null==no error
			}))
			//Log everything to a file (specific to user name so when we add more users each get 
			//their own file)
			.pipe(fsX.native.createWriteStream(logfile_base.replace('XXX',DEFAULT_USER)))
		;

		userObj.process.on('error',self.log.error);

		//Finally return a promise which resolves when the 'running' event is emitted
		return new Promise((resolve,reject)=>{
			userObj.process.on('logged_in',()=>{
				_private.cats[user]=null; //init this value
				resolve();
			});
		});

	}

	function onStart(uri,user){
		switch(_private.nowPlaying){
			case 'spotify:connect':
				self.log.info("spotify:connect now listening to: ",uri);
				// _private.streamObj.emit('now_playing',uri)
				return;
			case null:
				self.log.info("Playing single track ",uri);
				play(); //2018-12-10: Attempt to make music start without opening app in phone
				break;
			case uri:
				self.log.info("Duplicate play notice for track ",uri);
				break;
			default:
				self.log.warn("INTERUPTED ",_private.nowPlaying," to put on ",uri);
				stopCurrent(user); //kill the stream so it doesn't start playing something else
		}
		_private.nowPlaying=uri;
	}

	function onFinish(uri,user){
		switch(_private.nowPlaying){
			case 'spotify:connect':
				self.log.info("spotify:connect finished listening to",title)
				//do nothing for now, but we'll want to emit something on the streamObj
				return;
			case uri:
				self.log.info("Finished loading track ",uri)
				stopCurrent(user); //ends the cat of the fifo, turning what would otherwise be a cont. stream into distinct tracks
				break;
			default:
				self.log.warn('onFinish() got an unexpected value:',uri)
				self.log.warn('_private.nowPlaying:',_private.nowPlaying)
				// throw new Error("BUGBUG: the currently playing track SHOULD be",_private.nowPlaying,", but",uri," just finished");
		}
		_private.nowPlaying=null;
	}


	/*
	* Send an MPRIS command to the spotifyd daemon via DBus
	*
	* NOTE: Most MPRIS methods don't return a response, instead a signal is emitted when the command has had an effect: 
	*			org.freedesktop.DBus.Properties.PropertiesChange
	*
	* @param string 	method 		 	Dot-delimited string of interface and method, eg. org.mpris.MediaPlayer2.Player.Play
	* @param mixed 		methodArgs 		String or array or strings
	*
	* @return Promise  					Promise which resolves/rejects with an object, @see cpX.execFileInPromise()
	*/
	function dbusCmd(method, methodArgs){
		//If the daemon isn't running, there's nobody to receive the command, so fail
		if(cpX.childStatus(_private.daemons[DEFAULT_USER].process)=='not_running')
			return Promise.reject(new Error('Cannot send dbus command because spotifyd is not running'));

//2018-10-22: see NOTE. we're changing it to just send the command
		// var args=['--print-reply','--reply-timeout=2000','--dest='+dbus.lvl1_ServiceName,dbus.lvl2_ObjectPath];
		var args=['--type=method_call','--dest='+dbus.lvl1_ServiceName,dbus.lvl2_ObjectPath];
		
		args.push(method);
		
		if(typeof methodArgs=='string')
			args.push(methodArgs);
		else if (cX.varType(methodArgs)=='array')
			args=args.concat(methodArgs);

		self.log.info('dbus-send '+args.join(' '));
		return cpX.execFileInPromise("dbus-send", args);
	}



}

// dbus-send --dest=org.freedesktop.DBus /org/freedesktop/DBus  org.freedesktop.DBus.NameAcquired
