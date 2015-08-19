// TODO: check asgard for IPs from different ASGs (allow override w/ cmd-line properties)
// TODO: make a real git client so that it's possible to manipulate commits, etc.
// TODO: support for branches other than master
// TODO: get changes in base AMI
// TODO: option to suppress detailed commit logs
// TODO: abstract the plumbing bits to make it easier to add a web frontend
// TODO: revisit the whole shell script thing. Yuck.

/*
  data formats used herein:

  artifacts['artifact'] and service['repoName'] are both = {
      name:        'name'     // filled in by fillPaths
      project:     'name'     // filled in by fillPaths
      repo:        'name'     // filled in by fillPaths
      repoDir:     'dir'      // filled in by fillPaths
      gitLog:      'file'     // filled in by fillPaths
      repoSubDir:  'dir'      // filled in by fillPaths
      first: {
          revision: 'abcd',
          version: '0.1-23' // filled in by fillRevisions
      },
      second: {
          revision: 'abcd',
          version: '0.1-23' // filled in by fillRevisions
      }
  }
 */

const optimist = require('optimist')

        .alias('f', 'first')
        .describe('f', 'Hostname or IP with optional port number of first server (earlier build)')

        .alias('s', 'second')
        .describe('s', 'Hostname or IP with optional port number of second server (later build)')

        .alias('p', 'port')
        .default('p', 8077)
        .describe('p', 'the default Karyon port to use if not specified in value to --first or --second switches')

        .alias('d', 'dir')
        .default('d', '/tmp/allegro')
        .describe('d', 'working directory for git and scratch pad')

        .alias('h', 'html')
        .describe('h', 'produce content in html')

        .alias('w', 'wiki')
        .describe('w', 'produce content in wiki (Confluence) markup')

        .alias('z', 'suppressLogs')
        .describe('z', 'suppress detailed git logs for jars')

        .alias('c', 'includeCommitId')
        .describe('c', 'include git commit ids with the commit messages')

        .alias('a', 'all')
        .describe('a', 'show all artifacts, even if they didn\'t change')

        .boolean('debug')
        .describe('debug', 'print debug messaging on internal workings')

        .usage('Create release notes for two builds of the same application running on different hosts ' +
            '(karyon must be running on the same port on both hosts).\nUsage: $0')

const http = require('http'),
    sprintf = require('sprintf'),
    fs = require('fs'),
    path = require('path'),
    exec = require('child_process').exec,
    Table = require('cli-table')

// These widths need to include more than the text to allow for the spaces that Node inserts.
const amiIdWidth = 17
const artifactWidth = 35
const dateWidth = 21
const usernameWidth = 12
const versionWidth = 24

var argv = optimist.argv
if (argv.help) {
    console.log(optimist.help())
    process.exit(0)
}

const bpsJarPattern=/(.+)\-([0-9.]+\-[0-9.]+)$/
const thirdPartyJarPattern=/(.*)(?:[_-])([0-9]+(?:\.[0-9]+)*(?:[.-][A-Za-z][A-Za-z0-9_]+|_[0-9]+)?)/
const stashGitUrl = "ssh://git@stash.blackpearlsystems.com/%s/%s.git"

var baseDir = argv.dir
setup(baseDir)

var url0 = createHostUri(argv.first, argv.port)
var url1 = createHostUri(argv.second, argv.port)

var instanceCount = 0
var instanceInfo = [null, null]
getInstanceInfo(url0, 0)
getInstanceInfo(url1, 1)

function withFormat(options) {
    if (argv.html) {
        // replace table rendering characters with tags for html tables, note extra empty column
        options.chars = {
              'top': ''
            , 'top-mid': ''
            , 'top-left': '<table>'
            , 'top-right': '<tr>'
            , 'bottom': ''
            , 'bottom-mid': ''
            , 'bottom-left': ''
            , 'bottom-right': '</td></table>'
            , 'left': '<td>'
            , 'left-mid': '</td></tr>'
            , 'mid': ''
            , 'mid-mid': ''
            , 'right': '</td><td>'
            , 'right-mid': '<tr>'
        };
        // avoid style settings which produce colors
        options.style = {
              'padding-left': 0
            , 'padding-right': 0
            , 'compact' : false
        };
    } else if (argv.wiki) {
        // replace table rendering characters with bars for wiki tables
        options.chars = {
              'top': ''
            , 'top-mid': ''
            , 'top-left': ''
            , 'top-right': ''
            , 'bottom': ''
            , 'bottom-mid': ''
            , 'bottom-left': ''
            , 'bottom-right': ''
            , 'left': '|'
            , 'left-mid': ''
            , 'mid': ''
            , 'mid-mid': ''
            , 'right': '|'
            , 'right-mid': ''
        };
        // avoid style settings which produce colors
        options.style = {
              'padding-left': 1
            , 'padding-right': 1
            , 'compact' : true
        };
    } else if (typeof(process.stdout) === 'undefined') {
        // avoid style settings which produce colors
        options.style = {
              'padding-left': 1
            , 'padding-right': 1
            , 'compact' : true
        };
    }
    return options
}

Object.defineProperty(String.prototype, 'asHeadline', {
    get: function () {
        if (argv.html) {
            return "<h2>" + this + "</h2>";
        } else if (argv.wiki) {
            return "h2. " + this;
        } else if (typeof(process.stdout) === 'undefined') {
            return this;
        } else {
            return this.bold.green;
        }
    }
})

function asComment(msg) {
    if (argv.html) {
        return "<!-- " + msg + " -->";
    } else if (argv.wiki) {
        return "";
    } else {
        return msg;
    }
}

function createHostUri(endpoint, defaultPort) {
    if (endpoint.indexOf(':') > 0) {
        return sprintf("http://%s", endpoint)
    } else {
        return sprintf("http://%s:%s", endpoint, defaultPort)
    }
}

function setup(base) {
    if (!fs.existsSync(base)) {
        fs.mkdirSync(base)
        fs.mkdirSync(base + "/ser")
        fs.mkdirSync(base + "/data")
    }
}

function printHeader() {
    var table = new Table(withFormat({
        head: ['Build Date', 'AMI ID', 'Version']
        , colWidths: [dateWidth, amiIdWidth, versionWidth]
    }))

    table.push(
        [instanceInfo[0].buildDate, instanceInfo[0].amiId, instanceInfo[0].version]
        , [instanceInfo[1].buildDate, instanceInfo[1].amiId, instanceInfo[1].version]
    )

    if (argv.html) {
        console.log("<h1>Build info for " + instanceInfo[0].repo + "</h1>")
    } else if (argv.wiki) {
        console.log("h1. Build info for " + instanceInfo[0].repo)
    } else {
        console.log("Build info for " + instanceInfo[0].repo.bold.green)
    }
    console.log(table.toString())
}

function clone(arr) {
    var copy = {}
    for(var key in arr) {
        copy[key] = arr[key]
    }
    return copy
}

function doConfigDiff() {
    var systemProps = union(instanceInfo[0].config, instanceInfo[1].config)
    var partitionedSystemProps = partition(systemProps, instanceInfo[0].config, instanceInfo[1].config)

    var columns = [
        {title: "property"},
        {title: "value"}
    ]
    printPartitionTables("Properties", columns, partitionedSystemProps)
}

function doJarDiff() {
    var firstArtifacts = instanceInfo[0].allArtifacts
    var secondArtifacts = instanceInfo[1].allArtifacts
    var combinedArtifacts = union(firstArtifacts, secondArtifacts)
    var partitionedArtifacts = partition(combinedArtifacts, firstArtifacts, secondArtifacts)

    var columns = [
        {
            title: "artifact",
            width: artifactWidth
        },
        {
            title: "version",
            width: versionWidth
        }
    ];
    printPartitionTables("Artifacts", columns, partitionedArtifacts)
}

function printPartitionTables(namePlural, columns, partition) {

    if (argv.all && 'same' in partition) {
        printTable(sprintf("%s same in both", namePlural), columns, partition.same)
    }


    if ('onlyFirst' in partition) {
        printTable(sprintf("%s only in first", namePlural), columns, partition.onlyFirst)
    }

    if ('onlySecond' in partition) {
        printTable(sprintf("%s only in second", namePlural), columns, partition.onlySecond)
    }

    if ('bothMismatch' in partition) {
        var firstTitle = sprintf("first %s", columns[1].title);
        var secondTitle = sprintf("second %s", columns[1].title);
        var firstColumn = {title: firstTitle};
        var secondColumn = {title: secondTitle};
        if('width' in columns[1]) {
            firstColumn.width = columns[1].width;
            secondColumn.width = columns[1].width;
        }
        var bothMismatchColumns = [columns[0], firstColumn, secondColumn]
        printFirstSecondTable(sprintf("%s different in both", namePlural), bothMismatchColumns, partition.bothMismatch)
    }
}

function printTable(headline, columns, items) {
    if (typeof items !== 'object' || items == null)
        return;

    var table = createTable(columns);

    var keys = Object.keys(items).sort()
    var numKeys = keys.length;

    for (var i = 0; i < numKeys; i++) {
        var item = keys[i];

        table.push(
            [item, items[item]]
        );
    }

    if(Object.keys(items).length > 0) {
        console.log("\n" + headline.asHeadline);
        console.log(table.toString() + "\n");
    }
}

/*
[
  {
    title: "Artifact", // Required.
    width: 16,         // Optional. defaults to an even portion of remaining width.
    maxWidth: 8,       // [NOT USED YET] Optional. Will shrink the size of the column if the data doesn't exceed some width.
  },
  {
    title: "First Version",
    width: 12,
  },
  {
    title: "SecondVersion",
    width: 12,
  }
]
 */
function createTable(columnsIn) {
    var columns = [];
    var columnsToCompute = [];
    var usedWidth = 0;
    for(var i = 0; i < columnsIn.length; i++) {
        var column = {title: columnsIn[i].title};
        if( 'width' in columnsIn[i]) {
            column.width = columnsIn[i].width
            usedWidth += columnsIn[i].width
        } else {
            columnsToCompute.push(i);
        }
        columns.push(column)
    }
    var defaultColumnWidth = computeLastColumnsWidth(columnsToCompute.length, usedWidth, 1024);
    for(var i = 0; i < columnsToCompute.length; i++) {
        columns[columnsToCompute[i]].width = defaultColumnWidth;
    }

    var heads = [];
    var widths = [];
    for(var i = 0; i < columns.length; i++) {
        heads.push(columns[i].title);
        widths.push(columns[i].width);
    }

    return new Table(withFormat({
        head: heads,
        colWidths: widths
    }))
}

function printFirstSecondTable(headline, columns, items) {
    var table = createTable(columns);

    var keys = Object.keys(items).sort()
    var numKeys = keys.length

    for (i = 0; i < numKeys; i++) {
        var key = keys[i]

        table.push(
            [key, items[key].first, items[key].second]
        )
    }

    if(Object.keys(items).length > 0) {
        console.log(headline.asHeadline)
        console.log(table.toString())
    }
}

function tryExtractVersions(jars) {
    var extracted = {}
    var patterns = [ bpsJarPattern, thirdPartyJarPattern ]
    for(var jar in jars) {
        var found = false
        for(var i in patterns) {
            var pattern = patterns[i]
            if(pattern.test(jar)) {
                var matches = pattern.exec(jar)
                extracted[matches[1]] = matches[2]
                found = true
                break
            }
        }
        if (!found)
            extracted[jar] = ""
    }
    return extracted
}

function guessProjectName(artifact) {
    if (/^agamemnon/.test(artifact))
        return 'data'
    if (/^collector/.test(artifact))
        return 'data'
    if (/^parnassus/.test(artifact))
        return 'data'
    if (/^tartarus/.test(artifact))
        return 'data'
    return 'ser'
}

function guessRepoName(artifact) {
    if (/persistor/.test(artifact))
        return ["persistor"]
    if (/(model|protobuf)/.test(artifact))
        return ["model"]
    if (/^utilities/.test(artifact))
        return ["utilities"]
    if (/^(libtoken|tokentest|libtokenserver|token\-manager)/.test(artifact))
        return ["libtoken"]
    if (/^baseserver/.test(artifact))
        return ["baseserver"]
    if (/^atom\-sync$/.test(artifact))
        return ["atom-sync"]
    if (/^clu/.test(artifact))
        return ["clu"]
    if (/^hestia/.test(artifact))
        return ["delphi"]
    if (/^pythia/.test(artifact))
        return ["delphi"]

    var repoName = artifact.split('-')[0]
    return [repoName, artifact]
}

function doServiceRepoDiff(repoBase) {
    var artifacts = []
    var repoName = instanceInfo[0].repo
    artifacts[instanceInfo[0].repo] = [repoName]
    var cmds = writeCloneShellScript(artifacts, repoBase)
    var serviceRepoScript = path.join(repoBase, "serviceRepoClone.sh")
    writeScript(serviceRepoScript, cmds)
    var service = []
    service[repoName] = {
        name: instanceInfo[0].name,
        project: instanceInfo[0].project,
        repo: instanceInfo[0].repo,
        repoPath: path.join(path.join(repoBase, instanceInfo[0].project), repoName),
        first: {
            revision: instanceInfo[0].revision,
            version: instanceInfo[0].version
        },
        second: {
            revision: instanceInfo[1].revision,
            version: instanceInfo[1].version
        }

    }
    exec(serviceRepoScript, {}, function (error) {
        if(error) {
            console.log(error)
        } else {
            var cmds = makeGitLogScript(service)
            var gitLogScript = path.join(repoBase, "serviceGitLog.sh")
            writeScript(gitLogScript, cmds)
            exec(gitLogScript, {}, function (error, stdout, stderr) {
                console.log("\n")
                parseGitLog(stdout, service)
                printCommitLog(service)
                console.log(stderr)
            })
        }
    })

}

// foreach guess, if dir exists for one, do a git pull in that dir
// else, do a git clone for every one
// once all this is done, then check for dir exists and map
// TODO: turn this into generic cmd-line tool that can update all repos
function writeCloneShellScript(artifacts, repoBase) {
    // need map
    // artifact -> [guesses]
    var flat = []
    for(var artifact in artifacts) {
        debug("... writeCloneShellScript into " + repoBase + " for " + artifact)
        var artifactsAr = []
        artifactsAr[artifact] = 0
        // TODO: flatten first so that dirs are unique
        var guesses = artifacts[artifact]
        // guess -> {guessedRepoDir: "", guessedLog: "", guessedCmd: "", artifacts: [artifact -> 0]}
        var found = false
        for(var i = 0; i < guesses.length; i++) {
            var guess = guesses[i]
            var projectGuess = guessProjectName(guess)
            var projectDirGuess = path.join(repoBase, projectGuess)
            var repoDirGuess = path.join(projectDirGuess, guess)
            var gitLogFile = path.join(projectDirGuess, guess + '.log')
            debug("... ... writeCloneShellScript: artifact " + artifact + " guess " + guess + " maybe repoDir " + repoDirGuess )
            if (flat[guess]) {
                flat[guess].artifacts[artifact] = 0
                continue
            }
            if (fs.existsSync(repoDirGuess)) {
                flat[guess] = {
                    guessedRepoDir: repoDirGuess,
                    guessedLog: gitLogFile,
                    guessedCmd : sprintf(
                        'cd %-32s && git pull && git log --author=builds@blackpearlsystems.com --pretty=format:"%%H %%s" > %s',
                        repoDirGuess, gitLogFile
                    ),
                    artifacts: artifactsAr
                }
                found = true
                break;
            }

        }
        if(!found) {
            // try doing a clone for each guess
            for(var i = 0; i < guesses.length; i++) {
                var guess = guesses[i]
                var projectGuess = guessProjectName(guess)
                var projectDirGuess = path.join(repoBase, projectGuess)
                var guessRepo = guess
                var gitLogFile = path.join(projectDirGuess, guess + '.log')
                var url = sprintf(stashGitUrl, projectGuess, guess)
                if(flat[guess]) {
                    flat[guess].artifacts[artifact] = 0
                } else {
                    var repoDirGuess = path.join(repoBase, guess)
                    flat[guess] = {
                        guessedRepoDir: repoDirGuess,
                        guessedLog: gitLogFile,
                        guessedCmd : sprintf(
                            'cd %-20s && git clone %-70s || true && cd %-20s && git log --author=builds@blackpearlsystems.com --pretty=format:"%%H %%s" > %-50s || true',
                            projectDirGuess, url, guessRepo, gitLogFile
                        ),
                        artifacts: artifactsAr
                    }
                }
            }
        }
    }
    var cmds = []
    for(var guess in flat) {
        var cmd = flat[guess].guessedCmd
        cmds.push(cmd)
    }
    return cmds
}

function makeGitLogScript(artifacts) {
    // do this for each artifact:
    // git log --date=iso8601 --pretty=format:"%ad | %H | %ae | %s" firstCommit..secondCommit
    var cmds = []
    for(var artifact in artifacts) {
        var artifactObj = artifacts[artifact]
        debug("... makeGitLogScript handling " + artifact + " name " + artifactObj.name + " project " + artifactObj.project + " repo " + artifactObj.repo + " repoPath " + artifactObj.repoPath + " repoSubDir " + artifactObj.repoSubDir + " first revision " + artifactObj.first.revision + " second revision " + artifactObj.second.revision)
        if(artifactObj.repoPath != null
            && artifactObj.first.revision != null
            && artifactObj.second.revision != null)
        {
            var subdir = ""
            if (artifactObj.repoSubDir != null) {
                subdir = artifactObj.repoSubDir
            }
            cmds.push(
                sprintf(
                    'pushd %-32s > /dev/null && git log --date=iso8601 --pretty=format:"%s|%%ad|%%H|%%ae|%%s" %s..%s %30s | grep -v \"Merge branch \'master\'\" | grep -v \'\\[Gradle\\]\'',
                    artifactObj.repoPath, artifact, artifactObj.first.revision, artifactObj.second.revision, subdir
                )
            )
        }
    }
    return cmds
}

function writeScript(script, cmds) {
    if(fs.existsSync(script))
        fs.unlinkSync(script)
    var contents = "#!/bin/sh\n" + cmds.join("\n")
    fs.writeFileSync(script,
        contents, {mode: 0755})
}

function fillPaths(basePath, artifacts) {
    for(var artifact in artifacts) {
        debug("... fillPaths: handling " + artifact)
        var guessedProject = guessProjectName(artifact)
        var projectPath = path.join(basePath, guessedProject)
        var guesses = guessRepoName(artifact)
        for (var j in guesses) {
            var guess = guesses[j]
            var guessedPath = path.join(projectPath, guess)
            debug("... ... fillPaths: guessing " + guess + " is named " + artifacts[artifact].name + " project " + guessedProject + " at " + guessedPath)
            if (fs.existsSync(guessedPath)) {
                artifacts[artifact].project = guessedProject
                artifacts[artifact].repo = artifact
                artifacts[artifact].repoPath = guessedPath
                artifacts[artifact].gitLog = path.join(projectPath, guess + '.log')
                debug("... ... fillPaths: repoPath " + guessedPath + " with gitLog " + artifacts[artifact].gitLog)
                var subdir = guessSubdir(guessedPath, artifacts[artifact])
                if (subdir != null) {
                    artifacts[artifact].repoSubDir = subdir
                    debug("... ... fillPaths: repoSubDir " + subdir)
                }
                break;
            } else {
                debug("... ... fillPaths: did not find repoPath " + guessedPath + "; clearing values")
                artifacts[artifact].project = null
                artifacts[artifact].repoPath = null
                artifacts[artifact].repoSubDir = null
                artifacts[artifact].gitLog = null
            }
        }
    }
}

function guessSubdir(repoPath, artifact) {
    var artifactBase = artifact.name.split('-')[0]
    debug("... ... ... guessSubdir: repoPath " + repoPath + " artifact.project " + artifact.project + " artifactBase " + artifactBase + " artifact.name " + artifact.name)
    var guesses = [artifact.name, artifactBase + '/' + artifact.name]

    for(var i in guesses) {
        var guess = guesses[i]
        if(fs.existsSync(path.join(repoPath, guess))) {
            return guess
        }
    }
    return '.'
}

function fillRevisions(artifacts) {
    for(var artifact in artifacts) {
        // TODO: figure out async open file limit.
        if (artifacts[artifact].gitLog == null)
            continue
        var contents = fs.readFileSync(artifacts[artifact].gitLog, {encoding: 'utf8'})
        var firstRevision = extractRevision(contents, artifacts[artifact].first.version)
        if (firstRevision)
            artifacts[artifact].first.revision = firstRevision
        var secondRevision = extractRevision(contents, artifacts[artifact].second.version)
        if (secondRevision)
            artifacts[artifact].second.revision = secondRevision
    }
}

function extractRevision(input, version) {
    var pattern = new RegExp("^([^ ]+) .*'" + version + "'\\.$", "m")
    if(pattern.test(input)) {
        matches = pattern.exec(input)
        return matches[1]
    }
    return null
}


function karyonDone() {
    instanceCount++
    if(instanceCount >= 2) {
        printHeader()
        doJarDiff()
        doConfigDiff()
        doServiceRepoDiff(baseDir)

        if(argv.suppressLogs)
            return

        var bpsJars = union(instanceInfo[0].bpsArtifacts, instanceInfo[1].bpsArtifacts)
        var bpsJarsPartition = partition(bpsJars, instanceInfo[0].bpsArtifacts, instanceInfo[1].bpsArtifacts, function(first, second) {
            return {
                first: {
                    version: first
                },
                second: {
                    version: second
                }
            }
        })
        var jarMismatchVersion = bpsJarsPartition.bothMismatch

        // foreach key, map to a repo
        var artifacts = []
        for(var artifact in jarMismatchVersion) {
            artifacts[artifact] = guessRepoName(artifact)
        }

        var cmds = writeCloneShellScript(artifacts, baseDir)
        var cloneScript = path.join(baseDir, "libraryRepoClones.sh")
        writeScript(cloneScript, cmds)
        exec(cloneScript, {
            env: {
                SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK
            }
        },   function (error) {
            if (error !== null) {
                console.log("error: " + error)
            }

            // loop through each artifact in bothMismatch and find the log
            // fillPaths is sync
            fillPaths(baseDir, jarMismatchVersion)

            // fillRevisions is sync
            fillRevisions(jarMismatchVersion)

            var cmds = makeGitLogScript(jarMismatchVersion)

            var gitLogScript = path.join(baseDir, "libraryGitLogs.sh")
            writeScript(gitLogScript, cmds)
            exec(gitLogScript, {}, function (error, stdout, stderr) {
                parseGitLog(stdout, jarMismatchVersion)
                printCommitLog(jarMismatchVersion)
                console.log(stderr)
            })
        })

    }
}

/*
Partitions two maps based on presence/absence of keys in each map and also whether
or not the values match

{
    // key is present in both and has the same value in both
    'same': {key -> value},
    // key is present in both and has different values in each
    'bothMismatch': {key -> createValue(first, second)},
    // key is present only in the first map (value is from first map)
    'onlyFirst': {key -> value},
    // key is present only in the second map (value is from second map)
    'onlySecond': {key -> value}
}
*/
function partition(keys, first, second, mismatchStructure) {
    if (typeof mismatchStructure === 'undefined') {
        mismatchStructure = function(first, second) {
            return {
                'first' : first,
                'second' :  second
            };
        }
    }
    var bothMismatch = {};
    var same = {};
    var onlyFirst = {};
    var onlySecond = {};

    for(var key in keys) {
        if(first[key] != null && second[key] != null) {
            if (first[key] !== second[key]) {
                bothMismatch[key] = mismatchStructure(first[key], second[key])
                bothMismatch[key].name = key
            } else {
                same[key] = first[key]
            }
        } else {
            if(first[key] == null) {
                onlySecond[key] = second[key]
            } else {
                onlyFirst[key] = first[key]
            }
        }
    }

    var partition = {};
    if(Object.keys(bothMismatch).length > 0) {
        partition['bothMismatch'] = bothMismatch;
    }
    if(Object.keys(same).length > 0) {
        partition['same'] = same;
    }
    if(Object.keys(onlyFirst).length > 0) {
        partition['onlyFirst'] = onlyFirst;
    }
    if(Object.keys(onlySecond).length > 0) {
        partition['onlySecond'] = onlySecond;
    }

    return partition;
}

/*
// expect:
// 'artifact' ->   gitLog : [
{
    date:
    commitId:
    committer:
    message:
}

]
*/

function printCommitLog(artifacts) {
    for(var artifact in artifacts) {
        if (artifacts[artifact].gitLogs) {
            printArtifactHeader(artifacts[artifact].name, artifacts[artifact].first.version, artifacts[artifact].second.version)
            printGitLog(artifacts[artifact].gitLogs)
        }
    }
}


function computeLastColumnsWidth(numColumns, firstNColumnsWidth, maxColumnWidth) {
    var widthAllocation = process.stdout.columns - firstNColumnsWidth - 5
    if (isNaN(widthAllocation)) {
        widthAllocation = 200;
    } else if (widthAllocation < 50) {
        widthAllocation = 50;
    }

    var widthPerColumn = Math.floor(widthAllocation / numColumns);
    if (maxColumnWidth < widthPerColumn) {
        widthPerColumn = maxColumnWidth;
    }
    return widthPerColumn;
}

function printGitLog(logs) {
    var commitIdWidth = argv.includeCommitId ? 42 : 0
    var maxMessageLen = 0;

    for(var i = 0; i < logs.length; i++) {
        if (logs[i].message.length > maxMessageLen) {
            maxMessageLen = logs[i].message.length
        }
    }
    maxMessageLen += 2  // Spaces around the message

    var messageWidth = 50;
    if (argv.includeCommitId) {
        messageWidth = computeLastColumnsWidth(1, dateWidth + commitIdWidth + usernameWidth, maxMessageLen)
        var table = new Table(withFormat({
            head: ['Date', 'Commit ID', 'Committer', 'Message']
            , colWidths: [dateWidth, commitIdWidth, usernameWidth, messageWidth]
        }))

        for(var i = 0; i < logs.length; i++) {
            var log = logs[i]
            table.push([log.date, log.commitId, log.committer, log.message])
        }
    } else {
        messageWidth = computeLastColumnsWidth(1, dateWidth + usernameWidth, maxMessageLen)
        var table = new Table(withFormat({
            head: ['Date', 'Committer', 'Message']
            , colWidths: [dateWidth, usernameWidth, messageWidth]
        }))

        for(var i = 0; i < logs.length; i++) {
            var log = logs[i]
            table.push([log.date, log.committer, log.message])
        }
    }
    console.log(table.toString() + "\n")
}

function printArtifactHeader(artifactName, firstVersion, secondVersion) {
    console.log(sprintf("%s: %s -> %s", artifactName, firstVersion, secondVersion).asHeadline)
}

function parseGitLog(log, artifacts) {
    var lines = log.split('\n')
    for(var i = 0; i < lines.length; i++) {
        var fields = lines[i].split('|')
        if (fields.length >= 5) {
            var artifact = fields[0]
            var date = fields[1].split(' ').slice(0, 2).join(' ')
            var commitId = fields[2]
            var committer = fields[3].split('@')[0]
            // Do this just in case the commit message has a '\' in it
            var message = fields.slice(4).join('|')
            if(!artifacts[artifact].gitLogs)
                artifacts[artifact].gitLogs = []
            artifacts[artifact].gitLogs.push({
                date: date,
                commitId: commitId,
                committer: committer,
                message: message
            })
        }
    }
}

function union(first, second) {
    var uni = []
    for(var key in first)
      uni[key] = 0
    for(var key in second)
      uni[key] = 0
    return uni
}

/*
instanceInfo = [
{
  revision: 'abcd334',
  classpath: 'jar:sep:classpath'
  name: 'mcp'
  repo: 'mcp'
  version: '0.8-123'
  buildDate: '2013-09-20 02:34:48'
  amiId: 'ami'
  jars: ['', '', '']
  bpsArtifacts: {artifactId -> version}
  allArtifacts: {artifactId -> version}
  // System.properties
  config: {name -> value}
}
]
 */
function getInstanceInfo(url, i) {
    getJson(url + "/webadmin/props", function(json) {
        var properties = []
        properties['build.revision'] = 'revision'
        properties['java.class.path'] = 'classpath'
        properties['@appId'] = 'name'
        properties['build.name'] = 'altServiceRepo'
        properties['build.version'] = 'version'
        properties['build.date'] = 'buildDate'
        properties['EC2_AMI_ID'] = 'amiId'

        var instance = extractFromJson(properties, json)
        if (typeof(instance.name) === 'undefined') {
            var serviceSuffix = instance.altServiceRepo.indexOf('-service')
            // TODO: temp hack because the MCP repo changed names. Figure out a better workaround.
            if (serviceSuffix > 0) {
                instance.name = instance.altServiceRepo.substring(0, serviceSuffix)
            }
        }

        instance.repo = instance.name
        instance.project = guessProjectName(instance.name)

        if (instance.name === "presence") {
            instance.repo = "dumont"
        }
        if (instance.name === "hestia") {
            instance.repo = "delphi"
        }
        if (instance.name === "pythia") {
            instance.repo = "delphi"
        }

        if (typeof(instance.buildDate) === 'undefined') {
            instance.buildDate = '<unknown>'
        }

        if (typeof(instance.version) === 'undefined') {
            instance.version = '<unknown>'
        }

        instance.jars = parseClasspath(instance.classpath)
        instance.allArtifacts = tryExtractVersions(instance.jars)
        instance.bpsArtifacts = filterJars(instance.jars)
        if (!instance.amiId) {
            if (url.indexOf('http://localhost:') == 0) {
                instance.amiId = 'N/A'
            } else {
                instance.amiId = '<Unknown>'
            }
        }
        instanceInfo[i] = instance
        karyonDone()
    })
}

function getJson(url, callback) {
    console.log(asComment(sprintf("fetching json from %s", url) + ""))
    http.get(url, function(stream) {
        stream.setEncoding('utf8')
        var output = ""
        stream.on('data', function(chunk){
            output += chunk
        })
        stream.on('end', function() {
            var json = JSON.parse(output)
            callback(json)
        })
    }).on('error', function () {
            console.log("err in request");
        })
        .end();
}

// property['name'] = 'correctedName'
function extractFromJson(properties, obj) {
    var extracted = {}
    var config = {}
    for(var i = 0; i < obj.data.length; i++) {
        var propName = obj.data[i].name
        if(properties[propName]) {
            var correctedName = properties[propName]
            extracted[correctedName] = obj.data[i].value
        } else {
            config[propName] = obj.data[i].value
        }
    }
    // Presumably, these are archaius config and environment variables for the instance.
    extracted['config'] = config
    return extracted
}

function parseClasspath(classpath) {
    var jars = classpath.split(":")
    var dependencies = []
    jars.forEach(function(jar) {
        var lastSlashIndex = jar.lastIndexOf("/")
        var lastDotIndex = jar.lastIndexOf(".")
        var jarName = jar.slice(lastSlashIndex + 1, lastDotIndex)
        dependencies[jarName] = 0
    })
    return dependencies
}

function filterJars(jars) {
    var dependencies = []
    for(var jar in jars) {
        if(bpsJarPattern.test(jar)) {
            var matches = bpsJarPattern.exec(jar)
            // artifact ID is the key, version is the value
            dependencies[matches[1]] = matches[2]
        }
    }
    return dependencies
}

function debug(s) {
    if (argv.debug) console.log(s)
}
