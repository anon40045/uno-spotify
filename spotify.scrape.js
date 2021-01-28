'use strict';
/*
* Spotify Scraper
*
* This module gets information about Spotify tracks, playlists etc.
*
* There are 2 main ways to do this:
*	1. Get the access token used by the webpage and contact the api directly which returns json objects
* 	2. Get the webpage and parse it using regexp for that same data
* This module prefers the first but falls back on the second.
*/

module.exports={
	getUriDetails:getUriDetails
	,getList:getList
	,search:search
};

const {h,httpX}=require(process.env.Q_DIR_LIB+'/util/util.node.js');
		

const BetterLog=require(process.env.Q_DIR_LIB+'/better_log.js');
const log=new BetterLog('SpotifyScrape');


/*
* @const func global.class.TrackObj 	Constructor for one of objects returned by getglobal.class.TrackObj
*/
/*
* @const func PlaylistObj 	Constructor for one of objects returned by getglobal.class.TrackObj
*/
// const {TrackObj,ListObj}=require('../library.js');


/*
* @var object webPages 		Keys are url's, values are @see httpX.get()
*/
var webPages={};

/*
* @var object trackInfo 	Keys are uri's, values are @see formatTrackInfo
*/
var trackInfo={};


/*
* @var string authToken 	Set and unset by getHeaders()
*/
var authToken=null;


//We'll need special options to play this... we found these on a gamble...
var outputOptions={	
	sampleRate:44100
	,bitDepth:16
	,channels:2
	,dataEncoding:'signed-integer'
	,format:'raw'	
}

const webAppUrl='https://open.spotify.com';

const apiUrl="https://api.spotify.com/v1";















/*
* Get information about a uri
*
* @return Promise(obj,<Error>)
*/


function getUriDetails(UriUrl){
	try{
		var x=parseUriUrl(UriUrl);
	} catch(err){
		return Promise.reject(err);
	}

	switch(x.type){
		case 'radio':
			return Object.assign(
				{
					type:'radio'
					,uri:x.uri
					,title:'Spotify connect ('+DEFAULT_USER+')'
					,duration:0
				}
				,outputOptions
			);
		case 'track':
			var t=trackInfo[x.uri];
			if(t)
				return (typeof t=='string' ? Promise.reject(t) : Promise.resolve(t)) 
			else{
				var apiStr='/tracks/'+x.id;
				return queryApi()
					.catch(err=>{
						log.info(`API '${apiStr}' failed, checking <script> tags for same object`)
						//NOTE 2018-11-08: if defaultHeaders are used here, then the resulting page will not contain what we want...  
						return getApiObjectFromScriptTag(x)
					})
					.then(obj=>formatTrackInfo(obj,obj.album)) //sets on trackInfo and returns
					.catch(err=>backupFetch(err, x))
			}	
		case 'album':
		case 'playlist':
			var apiStr='/'+x.type+'s/'+x.id;
			return queryApi(apiStr)
				.catch(err=>{
					log.info(`API '${apiStr}' failed, checking <script> tags for same object`)
					return getApiObjectFromScriptTag(x)
				})
				.then(obj=>formatTracklistInfo(obj))
				.catch(err=>backupFetch(err, x))

		case 'user':
		//TODO: add api query first...
			return getUsersPlaylists(x.id).then(contents=>{
				
				return {
					type:'user'
					,uri:x.uri
					,title:x.id
					,contents:contents
				}
			})

		case 'artist':
			return Promise.reject("Not implemented yet");
		default:
			throw new Error("BUGBUG: we've added new type to parseUriUrl() but not here: "+String(x.type))
	};
}

/*
* @return Promise(array,str|<Error>)
*/

function getList(str,arg){
	try{cX.checkType('string',str)}catch(err){return Promise.reject(err)}

	//First we check for some keywords...
	switch(str){
		case 'genres':
		case 'moods':
			return getGenrePlaylists(arg);
		case 'podcasts':
			return getPodcastPlaylists(); //TODO: see below at function
		case 'user':
			return getUsersPlaylists(arg); //return array of [path, uri, name]
		default:
			return parsePageForTracklistUris(str);
	}
}




function search(searchTerm, options={}){
	
	var availableTypes=['album','playlist','artist','track','show_audio','episode_audio'];
	
	return new Promise(function _search(resolve,reject){
		//Validate args
		cX.checkType('string',searchTerm);
		cX.checkType('object',options);

		if(typeof options.type!='string' || availableTypes.indexOf(options.type)>-1)
			options.type='track';

		queryApi('search',{
			'type':options.type
			,'q':searchTerm+'*'
			,'best_match':false //true==add extra prop to result containing single best match
			,'limit':(typeof options.limit =='number' ? options.limit : 10) 
			,'offset':(typeof options.offset =='number' ? options.offset : 10)
		})
		.then(obj=>{
			// log.info("SUCCESS:",obj);
			obj=obj[options.type+'s'];

			var clean={
				type:options.type
				,offset:obj.offset
				,limit:obj.limit
				,total:obj.total
			};

			if(options.type=='track')
				clean.items=obj.items.map(t=>formatTrackInfo(t,t.album))
			else
				clean.items=obj.items.map(t=>formatTracklistInfo(t))
			
			return clean;
		})
		.then(resolve,reject)
	});
}



module.exports.parseUriUrl=parseUriUrl;
function parseUriUrl(UriUrl){
	UriUrl=cX.trim(UriUrl,true) //true==throw on fail

	if(UriUrl=='spotify:connect')
		return {
			type:'radio'
			,uri:'spotify:connect'
			,id:null
			,url:null

		}

	var m=UriUrl.match(/spotify.*(?:\:|\/)(playlist|album|track|user|artist)(?:\:|\/)(\w+)$/);
	if(m)
		return {
			type:m[1]
			,id:m[2]
			,uri:'spotify:'+m[1]+':'+m[2]
			,url:webAppUrl+'/'+m[1]+'/'+m[2]
		}
	else
		throw new Error("Not valid uri/url: "+cX.logVar(UriUrl));
}




// search('Kanye West').then(console.log,console.error);

// search('Kanye West','result').catch(console.error);
// getAuth().then(console.log,console.error);















/*
-------------------------------------- Common methods -----------------------------------
*/












/*
* @return Promise(string, string|<Error>) 	Resolves with html, rejects with @see httpX.get.err (string or <Error>)
*/
function getWebPage(UriUrl,options){
	log.traceFunc(arguments,'getWebPage')
	try{
		var url = httpX.url.parse(UriUrl).href;
	}catch(err){
		log.error(err);
 		var {url}= parseUriUrl(UriUrl);
	}
	return new Promise(function _getWebPage(resolve,reject){

	 	//If this is the first time we're getting the page, fetch it for real and save promise
		if(!webPages.hasOwnProperty(url))
			//TODO: add redirect addresses as well...
			webPages[url]=httpX.get(url,Object.assign({_followRedirects:2, _onlyContents:true}, options));
		else
			log.info('Using existing page');

		//Whenever ^^ promise finishes... (works even after...)
		Promise.race([webPages[url]]).then(resolve,reject);

		return;
	}).catch(err=>{log.makeError('Failed to get webpage: ',url,err).throw(); });
}







/*
* @param object track
* @param object album
*
* @sets trackInfo[xxx]
*
* @throw string 	Failure reason
* @return array 	Array of track id's that were set
*/
function formatTrackInfo(track, album){
	cX.checkType('object',track);
	cX.checkType('object',album);

	try{
		var info={
			type:'track'
			,uri:track.uri
			,title:track.name
			,duration:cX.round(track.duration_ms/1000,0)
			,artist:track.artists.map(a=>a.name).join(', ')
			,album:album.name
			,album_uri:album.uri
			,year:album.release_date.substring(0,4)
		}

		//Set on external object
		trackInfo[info.uri]=info;

		return info;

	}catch(err){
		// log.error(err,track,album);
		if(!err instanceof Error)
			err=new Error(String(err));
		err.message="Failed to format track info. "+err.message;
		throw err;
	}
}



function formatTracklistInfo(obj){
	var info={
		type:obj.type
		,uri:obj.uri
		,title:obj.name
		,thumbnail:obj.images[0].url
	}

	if(obj.type=='album'){
		info.contents=obj.tracks.items.map(track=>formatTrackInfo(track,obj)).map(({type,title,uri})=>({type,title,uri}));
		info.artist=obj.artists.map(a=>a.name).join(', ')
		info.year=obj.release_date.substring(0,4)
	}else{
		info.contents=obj.tracks.items.map(item=>formatTrackInfo(item.track, item.track.album)).map(({type,title,uri})=>({type,title,uri}));
		info.version=obj.snapshot_id
		info.creator=obj.owner.display_name||obj.owner.id
	}
			
	return info;
}
























/*
-----------------------------------  Method 1: Query API -----------------------------------------
*/

/*
* @return Promise(object,err) 		Resolves with same object that getApiObjectFromScriptTag() returns
*/
function queryApi(path,args={}){
	// return Promise.reject("BYPASSING API");
	//First we build the url... 
	try{
		var url=apiUrl+(path.substring(0,1)=='/'?'':'/')+path;

		//Allow complete opting out of args
		if(args!==false){
			//Combine passed in args with default ones
			var allArgs={
				decorate_restrictions:false //what does this do?
				,userless:true 				//what does this do?
				,market:'SE' 				//TODO: we need to set this dynamically
			}
			Object.assign(allArgs,args);

			//Turn object into query string
			var argArr=[];
			Object.entries(allArgs).forEach(([key,value])=>{
				let arg=key+'=';
				if(cX.varType(value)=='array')
					arg+=encodeURIComponent(value.join(','));
				else
					arg+=encodeURIComponent(String(value));
				argArr.push(arg);
			})

			//Add to url
			if(argArr.length)
				url+='?'+argArr.join('&');
		}

	} catch(err){
		return Promise.reject(err);
	}

	//Then we execute the request by adding headers...
	return getAuth()
		.then(bearer=>{
			var options={headers:{Authorization:bearer}};
			return getWebPage(url,options); //httpX.get() should return object if proper json is returned
		})
	;
}


function getAuth(){
	if(typeof authToken=='string')
		return Promise.resolve(authToken);

	// log.info("Fetching a new token");

	//For the response to contain the token, the request has to look like it comes from a browser...
	var apiHeaders=	{
		'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0'
		,'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
		,'Accept-Language': 'en-US,en;q=0.5'
		,'Accept-Encoding': 'gzip, deflate, br'
		,'Connection': 'keep-alive'
		,'Pragma': 'no-cache'
		,'Cache-Control': 'no-cache'
	}

	return httpX.get(webAppUrl+'/browse',{headers:apiHeaders})
		.then(obj=>{
			var errMsg="Could not get auth token from Spotify web client. ";
			let cookies=obj.headers['set-cookie'];
			if(cX.varType(cookies)!='array')
				throw errMsg+"No 'set-cookies' array found";
			for(let str of cookies){
				let m=str.match(/wp_access_token=([^;]+)/);
				if(m){
					log.info("Got new API token:",m[1]);
					return m[1];
				}
			}
			//If we're still running...
			throw errMsg+"'wp_access_token' not found amoung 'set-cookies'";			
		})
		.then(token=>{
			authToken='Bearer '+token;
			setTimeout(()=>{authToken=null},300)//destroy after 5 minutes
			return authToken;
		})

}

















/*
-----------------------------------  Method 2: Parse HTML -----------------------------------------
*/


/*
* @return array 	Array of uri's
*/
function parsePageForTracklistUris(pathOrUrl){
	var url=webAppUrl;
	if(pathOrUrl.substring(0,4)=='http')
		url=pathOrUrl
	else if(pathOrUrl.substring(0,1)=='/')
		url+=pathOrUrl
	else
		url+='/'+pathOrUrl

	return getWebPage(url).then(parseHtmlForTracklistUris);
}

/*
* @return array 	Array of arrays with single item: uri
*/
function parseHtmlForTracklistUris(html){
	var m;
	if(m=html.match(/\/(playlist|album)\/\w+/g)){
		var arr=[];
		m.forEach(str=>{
			let [type, id]=str.match(/\/(playlist|album)\/(\w+)/);
			arr.push(['spotify:'+type+':'+id]);
		})
		return arr;
	}else{
		throw 'No playlists or albums found';
	}
}



//TODO albums??
/*
* @return Promise(array,str) 	Best case the resolved array has 3 items (path, uri, title), less good case
*								it only contains the first 2
*/
function getUsersPlaylists(name){
	cX.checkType('string',name);
	log.trace("Getting playlists for user '"+name+"'");
	return getWebPage(webAppUrl+'/user/'+name)
		.then(html=>{
			// log.info(html);
			var playlists=[];
			var m=html.match(/<[^>]+\/playlist\/\w+"[^>]+alt=[^>]+>/g);
			if(m){
				log.debug("Found playlists in html")
				m.forEach(str=>{
					let n=str.match(/<[^>]+\/playlist\/(\w+)"[^>]+alt="([^"]+)"[^>]*>/);
					playlists.push({type:'playlist',uri:'spotify:playlist:'+n[1],'title':n[2]}); //uri and title
				//TODO 2019-04-03: do we know they're all playlists and not albums??
				})
			}else{
				log.note("TODO: Title not available in regular HTML. fetching for each playlist individually...")
			//TODO 2019-04-03: ^^
				playlists=parseHtmlForTracklistUris(html).map(([uri])=>parseUriUrl(uri)).map(({uri,type})=>({uri,type})); 
			}
			
			playlists.forEach(pl=>{pl.player='SpotifyPlayer'}); //2019-03-20: Setting player will be done by controller in future
						
			log.info(`Found ${playlists.length} playlists for user '${name}'`);											   
			return playlists														   
		})
	;
}


function getFeaturedPlaylists([path,savePath]){
	return getWebPage(webAppUrl+path)
		.then(html=>{
			log.info(html);
			var m=html.match(/<[^>]+title[^>]+\/playlist\/\w+">/g);
			if(m){
				var playlists=[];
				m.forEach(str=>{
					let n=str.match(/title="([^"])+"[^>]+\/playlist\/(\w+)">/)
					playlists.push('spotify:playlist:'+n[2],n[1],savePath);
				})
				return playlists;
			}
			return parseHtmlForTracklistUris(obj.data);
		})
		.then(arr=>arr.map(a=>[savePath].concat(a))); //add path to each item
}

//TODO 2018-11-06: Much more to get... look for the 'view more' links and follow...
function getPodcastPlaylists(){
	return getFeaturedPlaylists(['/browse/podcasts','/podcasts']);
}

/*
* @return Promise(array,)
*/
function getGenrePlaylists(onlyPath){
	return new Promise((resolve,reject)=>{
		try{
			//Most of them have the same format/location
			var genres=['pop','mood','workout','chill','hiphop','decades','party','edm_dance','rnb','rock','indie_alt','focus'
				,'dinner','holidays','jazz','sleep','metal','dansband','country','soul','classical','blues','latin'
				,'travel','punk','gaming','reggae','romance','funk','kids','popculture','kpop'
			].map(g=>['/genre/'+g+'-playlists','/genre/'+g]);

			//Some are special
			genres.push( ['/genre/afro-top_afro','/genre/afro'] );

			//And roots is a category all to itself
			var roots=['roots-featured-playlists','roots-moods','roots-covers','roots-revivals','roots-traditions','roots-run-deep'
				,'roots-artists','roots-releases'
			].map(r=>['/genre/'+r,'/genre/roots/'+r.substring(6).replace('-','_')])
			genres=genres.concat(roots);


			//If we only want one
			if(typeof onlyPath=='string'){
				genres=genres.filter(arr=>arr[1]==onlyPath);
				if(!genres.length)
					throw "Invalid playlist path: "+onlyPath;
			}

			//Now make all the promises and wait for all the promises to finish before resolving...
			cX.groupPromises(genres.map(getFeaturedPlaylists)).promise
				.catch(obj=>{
					//Log all rejections
					for(let err of obj.rejected){log.error(err)}

					if(!obj.resolved.length)
						throw log.makeError("Failed to get all "+obj.rejected.length+" playlists");
					else
						return obj.resolved;
				})
				.then(resolve,reject)
			;
		}catch(err){
			reject(err);
		}
	})

}


//TODO 2018-11-06: seems fetching vv url only loads a blank page with javascript which in turn loads the stuff we want...........
function findGenres(){
	return getWebPage(webAppUrl+'/browse/genres')
		.then(obj=>{
			log.info(obj.data);
			var m = obj.data.match(/<a class="mo-info-name" title=".+" dir="auto" href="\/view\/\w+-page">.+<\/a>/)
			log.info(m)
		})
}





/*
* The same information returned by the api sometimes exists in a <script> tag on various pages, this function 
* gets that page and looks for the tag and returns it as an object.
* 
* @return object 			Same object that queryApi returns
*/
function getApiObjectFromScriptTag(uriObj){
	cX.checkType('object',uriObj);

	return getWebPage(uriObj.url)
		.then(html=>{
			var msg='Failed to get api object from script tag';
			var m=html.match(/<script>[\s\S]+?<\/script>/g); //The info exists in a script tag
			if(m){
				m=m.filter(str=>str.match(/Spotify\s?=\s?\{\};/)); //Find the script in question
				if(m && m.length){
					// var arr=m[0].split('{"added_at');
					var arr=m[0].split('Spotify.Entity = ');
					// log.info(arr[1]);
					m=arr[1].match(/([\s\S]+);\s+<\/script>/);
					// log.info(m[1]);
					return JSON.parse(m[1]); //At this point we should have isolated a JSON object, so parse it
					
				}else throw new Error(msg);
			}else{
				// log.info(html);
				throw new Error(msg+' (no script tags found at all)');	
			} 
		})
	;
}








function backupFetch(prevErr,uriObj){
	log.info("Problems fetching detailed info, falling back on parsing <head>:",prevErr)
	return getWebPage(uriObj.url)
		.then(html=>{

			var info = parseHtmlHead(html);
			info.type=uriObj.type;

			if(uriObj.type=='track' && cX.varType(info.tracks)=='array'){
				info.uri=info.tracks.shift()
				delete info.tracks;
			}else{
				info.uri=uriObj.uri;
			}
			return info;
		})
		.catch(err=>{
			log.makeError(err).prepend('Backup fetch failed. ').throw();
		})
	;
}

function uriOrNull(UriUrl,type){
	try{
		var x= parseUriUrl(UriUrl)
		if(type && type!=x.type)
			return null;
		return x.uri;
	}catch(err){
		return null;
	}
}

/*
* Parse the <head> tag and try to extract info from it. Good as backup if regular fetch fails.
*
* @return object
*/
function parseHtmlHead(html){
	var m,ret={}; 
	
	try{
		//Everything good seems to be in the <head> tag, so grab that to speed up regexps later,
		if(m=html.match(/<head>[\s\S]+<\/head>/))
			var head=m[0];
		else
			throw 'NO_HEAD_TAG';
		// log.info(head);
		

		//The name of the playlist is in the title of the page
		if((m=head.match(/<title>(.+?)( on Spotify)?<\/title>/)) && m[1]!='Spotify Web Player')
			ret.title=decodeURI(m[1]);
		else if(m=head.match(/<meta property="og:title" content="([^"]+)">/))
			ret.title=decodeURI(m[1]); //2018-11-08: not working...
		

		
			

		//Doesn't matter if these fail...
		m=head.match(/<meta property="og:image" content="([^"]+)">/) //look for quote, then a capture all non-quotes until next quote
		ret.thumbnail = (m?m[1]:null);

		//If there's a creator, it's most likely a playlist, else an album
		if(m=head.match(/<meta property="music:creator" content=".+\/user\/(\w+)">/))
			ret.creator=m[1];
		else if(typeof ret.title =='string' && (m=ret.title.match(/^(.*) by (.*)$/))){
			ret.title=m[1];
			ret.artist=m[2];
		}


		if(m=head.match(/<meta property="music:album" content="([^"]+)">/))
			ret.album_uri=uriOrNull(m[1],'album');
		if(m=head.match(/<meta property="music:musician" content="([^"]+)">/))
			ret.artist_uri=uriOrNull(m[1],'artist');		
		

		if(m=head.match(/<meta property="music:duration" content="(\d+)">/))
			ret.duration=m[1];



		//The track id's are in meta tags in the <head>
		if(m=html.match(/\/track\/\w+/g)){
			ret.tracks=m.map(str=>'spotify:track:'+str.substring(7));
		}else{
			throw 'No tracks found in <meta> tags.'
		}

		return ret;
	// log.info(head);
	}catch(err){
		log.makeError(err).prepend("Problems parsing html <head>: ").throw();
	}

}

















		