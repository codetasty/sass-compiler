define(function(require, exports, module) {
	var ExtensionManager = require('code/extensionManager');
	
	var Code = require('code/code');
	var Socket = require('code/socket');
	var Workspace = require('code/workspace');
	var Notification = require('code/notification');
	var Fn = require('code/fn');
	
	var Sass = new require('./sass');
	
	var SassWorker = new Sass('/application/extension/sass-compiler/sass.worker.js');
	
	var EditorSession = require('modules/editor/ext/session');
	
	var Extension = ExtensionManager.register({
		name: 'sass-compiler',
		
	}, {
		init: function() {
			SassWorker.importer(function(request, done) {
				var ext = Fn.pathinfo(Extension.importPath).extension;
				var reqExt = Fn.pathinfo(request.current).extension;
				
				var toLoad = request.current;
				
				if (!reqExt) {
					toLoad += '.' + ext;
				}
				
				toLoad = Extension.parsePath(Extension.importPath, toLoad);
				
				Extension.getCache(Extension.importWorkspace, toLoad, function(data) {
					done({
						path: toLoad,
						content: data
					});
				});
			});
			
			EditorSession.on('save', function(data) {
				// var sess = EditorSession.sessions[data.id];
				
				if (data.session.extension == 'sass' || data.session.extension == 'scss') {
					var cache = Extension.cacheExists(data.session.workspaceId, data.session.path);
					if (cache) {
						cache.data = EditorSession.sessions[data.id].lastSavedValue;
					}
					
					Extension.compile(data.session.workspaceId, data.session.path, data.data.getValue());
				}
			});
			
			this.checkCache();
		},
		importWorkspace: null,
		importPath: '',
		cache: [],
		getCache: function(workspaceId, path, c) {
			var found = false;
			var self = this;
			
			this.cache.every(function(cache) {
				if (cache.workspaceId == workspaceId && cache.path == path) {
					found = true;
					
					cache.lastUsed = new Date().getTime();
					c(cache.data);
					
					return false;
				}
				
				return true;
			});
			
			if (!found) {
				Socket.send('workspace.action', {
					action: 'get',
					id: workspaceId,
					path: path,
					forceRemote: true,
					revision: true,
				}, false, function(data, stream) {
					var file = '';
					if (stream) {
						stream.on('data', function(chunk) {
							file += chunk;
						});
						
						stream.on('end', function() {
							self.addCache(workspaceId, path, file);
							c(file);
						});
					} else {
						self.addCache(workspaceId, path, file);
						c(file);
					}
				});
			}
		},
		cacheExists: function(workspaceId, path) {
			var found = false;
			var self = this;
			
			this.cache.every(function(cache) {
				if (cache.workspaceId == workspaceId && cache.path == path) {
					found = cache;
					
					return false;
				}
				
				return true;
			});
			
			return found;
		},
		addCache: function(workspaceId, path, file) {
			this.cache.push({
				workspaceId: workspaceId,
				path: path,
				data: file,
				lastUsed: new Date().getTime()
			});
		},
		checkCache: function() {
			var self = this;
			
			var cacheTime = new Date().getTime();
			cacheTime -= 180*1000;
			
			this.cache = this.cache.filter(function (value, index, array) {
				return (value.lastUsed > cacheTime);
			});
			
			setTimeout(function() {
				self.checkCache();
			}, 10000);
		},
		getOptions: function(content) {
			var firstLine = content.substr(0, content.indexOf('\n'));
			var match = /^\s*\/\/\s*(.+)/.exec(firstLine);
			var options = {};

			if (!match) {
				return options;
			}

			match[1].split(',').forEach(function(item) {
				var key, value, i = item.indexOf(':');
				if (i < 0) {
					return;
				}
				key = item.substr(0, i).trim();
				value = item.substr(i + 1).trim();
				if (value.match(/^(true|false|undefined|null|[0-9]+)$/)) {
					value = eval(value);
				}
				options[key] = value;
			});
			return options;
		},
		parsePath: function(path, out, canBeSame) {
			var destination = out;
			
			if (destination == '.' && canBeSame) {
				destination = path.replace(/(scss|sass)$/, 'css');
			} else if (out.substr(0, 1) == '/') {
				destination = out;
			} else {
				destination = path.split('/');
				destination.pop();
				destination = destination.join('/');
				destination += '/' + out;
			}
			
			destination = destination.replace(/\/\.\//gi, '/').split('/');
			
			destination.every(function(val, key) {
				if (val == '..') {
					destination[key] = '';
					var cc = 1;
					while ((key-cc) >= 0 && !destination[key-cc]) {
						cc++;
					}
					
					destination[key-cc] = '';
				}
				
				return true;
			});
			
			destination = destination.join('/').replace(/([\/]+)/gi, '/');
			
			if (destination == path) {
				return false;
			}
			
			return destination;
		},
		compile: function(workspaceId, path, doc) {
			var self = this;
			var options = this.getOptions(doc);
			
			if (!options.out) {
				return false;
			}
			
			var destination = this.parsePath(path, options.out, true);
			
			if (!destination) {
				return false;
			}
			
			//var mainFile = options.main ? this.parsePath(path, options.main, false) : null;
			
			if (!destination.match(/\.(scss|sass)$/)) {
				this.render(workspaceId, path, doc, options, destination);
			} else {
				this.getCache(workspaceId, destination, function(data) {
					Extension.compile(workspaceId, destination, data);
				});
			}
		},
		render: function(workspaceId, path, doc, options, destination) {
			Extension.importWorkspace = workspaceId;
			Extension.importPath = path;
			SassWorker.compile(doc, function(result) {
				if (result.status) {
					Notification.open({
						type: 'error',
						title: _('SASS compilation failed.'),
						description: result.formatted
					});
				} else {
					Socket.send('workspace.action', {
						id: workspaceId,
						path: destination,
						action: 'save',
						revisions: false
					}, new Blob([result.text], {type: 'text'}));
				}
			});
		}
	});

	module.exports = Extension;
});